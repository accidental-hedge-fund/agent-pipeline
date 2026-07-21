## Context

`pipeline improve` (`core/scripts/improve.ts`) is a read-only batch analyzer: it streams every
run's `events.jsonl`, accumulates `Map<string, ClusterAccum>` keyed by `<category>:<signal>`, sorts
by count, truncates to `--top`, and — only under `--apply` — creates one GitHub issue per cluster at
or above `--min-occurrences`.

`papercut` events (#419) already flow through `appendEvent`, so they are injection-screened and
secret-redacted *at write time* and are already visible to `readEventsLines`. The `papercuts` config
block exists but carries a single `enabled` key.

Two things the issue assumes but the code does not have, established by reading the source:

1. **There is no dedup.** `applyIssues()` calls `deps.createIssue()` for every qualifying cluster
   with no lookup of existing issues, and `openspec/specs/improve-command/spec.md` states no dedup
   requirement. This change introduces it.
2. **There is no auto-file trigger surface.** Run finalization happens in `pipeline-run.ts` around
   `finalizeRun(...)`; queue batches finish in `stages/queue.ts` after `batch-summary.json` is
   written. Both are new hook sites.

## Goals / Non-Goals

**Goals**
- One clustering implementation shared by the manual (`improve --apply`) and automatic
  (`papercuts.auto_file`) paths — no second, divergent clusterer.
- Auto-filing that is inert by default and, when on, cannot affect run correctness or exit status.
- Agent-reported evidence stays visibly distinct from telemetry-inferred evidence.

**Non-Goals**
- Triaging, queueing, or advancing the filed issues (explicitly out of scope in #421).
- Changing the papercut capture channel, event shape, or prompt injection.

## Decisions

### D1 — Category isolation is structural, not heuristic

Cluster keys are already `<category>:<normalized-signal>`; adding `papercut:<normalized-message>`
means a papercut and a `flaky-gate:test_gate` cluster can never collide even when they describe the
same problem. We deliberately do **not** add cross-category similarity merging.

*Why:* the two signals have different epistemic status. A `flaky-gate` cluster says "this stage
errored N times"; a `papercut` cluster says "an agent found this annoying N times". Merging them
would launder an agent's subjective report into telemetry (and vice versa) and destroy the ability
to ask "what do agents complain about that our telemetry misses?" — the whole point of #419.

*Alternative rejected:* fuzzy merge on normalized-signal similarity. It is a one-way information
loss with no way to recover provenance, and the issue explicitly forbids it.

### D2 — Papercut signal is the normalized message, excerpt is the raw message

Cluster on `normalizeSignal(event.message)` (the existing normalizer: lowercase, strip SHA/`#N`/
line-number tokens, collapse whitespace). Excerpt is the message truncated to ≤200 chars via the
existing `truncateExcerpt`.

*Why:* reuses the normalizer that already gives the report its "same problem, different run"
behaviour, and keeps the papercut category structurally identical to `blocker` (which also clusters
a free-text field). Stage/harness/model are recorded as cluster context but are **not** part of the
key — the same friction reported from two stages is one friction.

### D3 — GitHub is the dedup source of truth; no local dedup state

Before creating an issue, list open issues whose title begins with `[pipeline-improve]` (one `gh
issue list` call, results cached for the invocation) and skip any cluster whose proposed title is
already present. Title equality is the match, because the title is deterministically derived from
`<category>:<normalized-signal>`.

*Why:* a local ledger would drift the moment a human closes, retitles, or files an issue by hand,
and would need its own gitignore/cleanup story (cf. #452). GitHub already holds the answer.

*Cost:* one extra `gh` call per `--apply`/auto-file invocation, not per cluster.

*Follows golden rule 5:* the exact `gh issue list --json` field names (`title`, `state`, `createdAt`,
`number`, `url`) MUST be confirmed against real output during implementation before coding against
them.

### D4 — The rate-cap window is also derived from GitHub, not from local state

`auto_file_max_per_window` is enforced by counting issues carrying the `pipeline:backlog` label with
the `[pipeline-improve]` title prefix whose `createdAt` falls inside the trailing
`auto_file_window_hours`. When that count is at or above the cap, no further auto-filing happens
this window; the clusters are logged as deferred.

*Why:* same reasoning as D3, plus it makes the cap correct across concurrent runs and across a queue
batch running many runs in parallel — a per-process counter would let N concurrent runs each file up
to the cap. This is a trailing window, not a wall-clock bucket, so a burst cannot be reset by a
clock boundary.

*Alternative rejected:* a counter in `.agent-pipeline/`. Concurrency-unsafe and adds engine-written
state that must then be gitignored.

### D5 — Auto-file is best-effort and structurally cannot fail a run

The hook is invoked as a fire-and-await call wrapped in a total function that catches everything and
logs a non-fatal warning — the same contract `recordPapercut()` already has, and the same
`.catch(() => {})` discipline the surrounding finalization code in `pipeline-run.ts` already uses.

*Why:* filing backlog issues is an observability side-effect. A GitHub outage must not turn a green
run red. Rigor is preserved because no review coverage is removed — this path never gates anything.

### D6 — Two trigger points, one implementation

`run_complete` (per-run) and queue-batch end (per-batch) both call the same
`autoFilePapercuts(opts, deps)`. The queue hook exists because a batch may run many issues whose
individual runs each see only their own papercuts; the batch-level pass is what makes a pattern
recurring *across* the batch visible. Dedup (D3) makes double-filing between the two harmless.

### D7 — Body sanitization is belt-and-braces

Papercut messages are already screened and redacted at write time by `appendEvent`. The issue body
builder nonetheless passes assembled detail text through `sanitize()` from `artifact-sanitize.ts`
before creating the issue, and prefixes the body with an explicit agent-reported provenance banner.

*Why:* the body is assembled from stored events into a surface a human will read and act on;
re-sanitizing costs nothing and defends against an event written by an older engine version.

## Risks / Trade-offs

- **Issue-noise risk.** Auto-filing could flood the backlog. Mitigated by three independent brakes:
  default-off, `auto_file_min_occurrences`, and `auto_file_max_per_window` (D4) — plus dedup (D3).
- **Dedup by title is brittle to manual retitling.** A human who renames an auto-filed issue lets a
  duplicate be filed. Accepted: the alternative (a machine key in the body, parsed back) is more
  machinery than the failure mode warrants, and the rate cap bounds the damage.
- **Extra `gh` calls.** One list call per invocation (D3/D4 can share it). Bounded and counted by the
  existing gh-metrics collector.

## Migration Plan

Purely additive. Existing configs have no `auto_file` key, so `auto_file` resolves to `false` and
every code path is byte-identical to today. The dedup change to `improve --apply` is behaviour-
changing but strictly in the safe direction (fewer duplicate issues); it is covered by its own
requirement and test.

## Open Questions

None blocking. Field-name verification for `gh issue list --json` (D3) is an implementation task,
not an open design question.
