# Design — durable-run-blocker auto-file

## Context

`pipeline improve` clusters recurring failure evidence from `.agent-pipeline/runs/`
events and (with `--apply` / auto-file) turns qualifying clusters into
`pipeline:backlog` issues, reusing one shared machinery for the papercut (#421)
and correction (#500) sources: `autoFileClusterCategory` in
`core/scripts/stages/papercut.ts` performs minimum-occurrence gating, open-issue
dedup, per-window rate cap, sanitization, provenance marking, and cross-host
post-create reconciliation, parameterized by an `AutoFileCategory`
(`eventType` + `clusterFn` + `buildBody` + `marker` + `logPrefix`).

Durable-run blockers (#509) live in a **different store**: the durable-loop state
home (`resolveStateHome` → `<state-home>/runs/<run-id>/`), holding `ledger.json`
(with per-item `blocked_theme: DurableBlockerClass`, `evidence_fingerprint`,
`repeated_evidence_count`, and `history`) and a terminal `LoopStopRecord`
(`ledger.stop`) carrying `reason`, `theme`, `fingerprint`, `item_id`. These are
never written into `.agent-pipeline/runs/events.jsonl`, so the existing category
machinery cannot see them without a new read seam.

## Goals / Non-Goals

**Goals**
- Reuse the #421 auto-file machinery (dedup, rate cap, sanitization, provenance,
  reconciliation) unchanged.
- Add a `durable-run-blocker` cluster identity keyed on `(class, fingerprint)`.
- Qualify a cluster on *terminal stop OR ≥ 2-run recurrence*, not a pure count.
- Suggest a milestone in the report/body; never assign one.

**Non-Goals**
- Re-implementing dedup/rate-cap. Re-classifying blockers. Auto-closing issues.
  Assigning milestones. Touching #502's upstream path.

## Decisions

### D1 — Cluster identity is `(blocker class, evidence fingerprint)`

The durable loop already computes a stable `evidence_fingerprint`
(`fingerprintEvidence`, loop/recovery.ts) that normalizes incidental
run-to-run variation (shas, numbers, whitespace, case) to a sha256. Two
structurally-identical blockers fingerprint identically across runs; materially
different evidence fingerprints distinctly. The cluster key is
`durable-run-blocker:<class>:<fingerprint>`, and the cluster's dedup/title
identity derives from that fingerprint — never from free-text evidence prose.
This mirrors the correction category's decision to key on a deterministic
`correction_key` rather than normalized prose (#500 review 1), so an issue's
identity is stable even when the human-readable evidence text drifts.

### D2 — The durable ledger is a distinct evidence source, read read-only

The `durable-run-blocker` category reads durable-run ledgers under the loop
state home, not `.agent-pipeline/runs/`. Reads go through the existing
`LoopStoreDeps` seam (or a narrowed read-only projection of it) so unit tests
inject an in-memory store and touch no filesystem — matching the store's own
dependency-seam convention. The scan is strictly read-only: it acquires no run
lock, writes no ledger, and appends no event. A single unreadable/partial ledger
is skipped, never fatal — consistent with the report path's tolerance of a
single bad run.

### D3 — Qualification: terminal stop OR ≥ 2-run recurrence

Unlike papercut/correction (`count ≥ minOccurrences`), a `durable-run-blocker`
cluster qualifies when **either**:
- a durable run recorded a terminal `LoopStopRecord` attributable to this
  `(class, fingerprint)` — files from a single run, because a terminal stop is
  itself the strong signal; **or**
- the same `(class, fingerprint)` occurs across ≥ 2 distinct runs (the recurring
  signal), with the recurrence threshold honoring the same `min_occurrences`
  floor of 2 the other auto-file sources use.

A single non-terminal occurrence satisfies neither branch and never files. This
predicate is expressed at the cluster layer; the shared `autoFileClusterCategory`
still applies its own dedup/rate-cap over the already-qualified set.

### D4 — Milestone is suggested, never assigned

The report and the filed-issue body include a **suggested** milestone, derived
deterministically from the blocker class / theme (a static class→milestone hint
map, e.g. engine-defect classes → an "engine hardening" suggestion), presented as
advisory text only. The created issue carries only the `pipeline:backlog` label —
no milestone, no assignee, no stage label — exactly as papercut/correction
issues do. Assignment stays a human/operator decision (`/pipeline` never assigns
milestones on auto-filed issues). This keeps the human "does this join the
release?" gate intact.

### D5 — Reuse the papercut path's cross-host-safe machinery unchanged

The category plugs into `autoFileClusterCategory` via a new `AutoFileCategory`
with its own provenance marker
(`<!-- pipeline:durable-run-blocker-auto-filed -->`, distinct from the papercut
and correction markers so reconciliation never confuses the three sources). It
inherits the papercut path's GitHub-authored-state dedup, in-window rate cap, and
post-create reconciliation as-is. No new dedup or rate-cap mechanism is
introduced, and no cross-host guarantee beyond what that reused mechanism already
provides is asserted for this source.

### D6 — Trigger at durable-run terminal stop, opt-in and total

Enabled durable-run-blocker auto-filing triggers when a durable run reaches a
terminal condition (the supervisor drive loop records a stop / all-done), gated
on a resolved `durable_runs.auto_file` setting that is absent/`false` by default.
The path is best-effort and total: any error — unauthenticated `gh`, unreadable
ledgers, a throwing create — is caught, logged non-fatal, and swallowed. It never
changes a run's or batch's exit status, never emits a blocker, and never prevents
ledger finalization. Config mirrors the papercut/correction blocks:
`auto_file`, `auto_file_window_hours`, `auto_file_max_per_window`,
`auto_file_min_occurrences` (floor 2, governing only the recurrence branch of
D3 — a terminal stop qualifies regardless).

## Risks / Trade-offs

- **Two evidence stores in one command.** The `durable-run-blocker` category
  reads a different root than the other five categories. Mitigated by routing all
  durable reads through a single injected store seam and documenting the source
  split in the spec so the divergence is intentional, not incidental.
- **Terminal-stop single-run filing could be noisy** if a class trips terminally
  often. Mitigated by the shared open-issue dedup (one open issue per
  `(class, fingerprint)` title) and the per-window rate cap — a recurring
  terminal stop maps to one tracked issue, not one per run.
