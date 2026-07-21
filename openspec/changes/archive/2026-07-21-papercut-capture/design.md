## Context

Papercuts are agent-self-reported friction notes written *from inside* a running stage: the
harness child process (claude/codex) shells out to the pipeline CLI while the parent engine
process is blocked waiting on it. That out-of-process, concurrent-with-the-run shape is the
constraint that drives most decisions below.

Existing machinery this change deliberately reuses rather than re-implements:

- `appendEvent()` in `run-store.ts` — append-only `events.jsonl` writes with `O_APPEND`
  semantics, write-time injection denylist, secret redaction, and external-sink delivery (#343).
- `emitHumanIntervention()` in `intervention.ts` — the "total function, never throws, warn on
  failure" emitter pattern.
- The `contextSnapshotSection()` / `carryForwardSection()` prompt pattern — an always-present
  `{{placeholder}}` that renders the empty string when the feature is inert.
- `COMMAND_REGISTRY` — declarative per-command flag allowlists.

## Goals / Non-Goals

**Goals**

- Zero behavior change when the `papercuts` config block is absent — including byte-identical
  prompt output.
- Recording a papercut can never change a run's outcome.
- Papercuts are ordinary run events, so redaction and sink delivery come for free and stay
  correct by construction rather than by parallel implementation.

**Non-Goals**

- Aggregation, clustering, dedup, rate limiting, or issue creation (explicit out-of-scope).
- Inferring friction from transcripts.
- Any human-facing browser beyond `--json`.

## Decisions

### 1. A papercut is a run event, not a new artifact file

**Decision:** add `PapercutEvent` to the `RunEvent` union and write it via `appendEvent`, into the
run's existing `events.jsonl`.

**Why:** the acceptance criteria demand sink parity and redaction parity with `blocker_set` /
`human_intervention`. Both are properties of the `appendEvent` path. A separate `papercuts.jsonl`
would require duplicating the denylist, redaction, and sink-delivery logic — three places to drift.
Reuse makes "identical to how other event types are redacted today" true by construction, and
`exclusive` sink mode keeps working unchanged.

**Shape:**

```
{
  schema_version: 1,
  type: "papercut",
  at: <ISO 8601 UTC>,
  run_id: <run id string>,
  issue: <issue number integer>,
  stage: <stage name string | null>,
  harness: <harness command string | null>,
  model: <model string | null>,
  message: <free-text agent message>
}
```

`schema_version` stays `1` — this is an additive union member, not a schema revision, matching how
`human_intervention` and `ignored_artifact_warning` were added.

### 2. Concurrent append from a child process is safe as-is

**Decision:** the `papercut` CLI opens the run's `events.jsonl` and appends through the same
`appendFile` (`O_APPEND`) seam the engine uses; no lock is taken.

**Why:** `run-store.ts` already documents `appendFile` as `O_APPEND`, and each event is written as
one `write()` of a single line well under `PIPE_BUF`. Taking `lock.ts` here would risk the child
blocking on a lock the parent holds — a deadlock that would stall the very run the papercut is
supposed to not disturb. Order between the child's papercut and the parent's concurrent events is
not guaranteed and is not required by any criterion.

### 3. Identity comes from the environment the engine already controls

**Decision:** when `papercuts.enabled` is true, the engine adds `PIPELINE_RUN_ID`,
`PIPELINE_ISSUE`, `PIPELINE_STAGE`, `PIPELINE_HARNESS`, and `PIPELINE_MODEL` to the harness child
process environment. The `papercut` command reads these as defaults; explicit flags win.

**Why:** the agent knows the *message*, not which stage/model slot it is running as. Asking it to
pass identity invites wrong or fabricated values. The engine already has all five facts at invoke
time. `--run <run-id>` remains the documented required argument (per the issue), so the command is
still usable by an operator outside a run; the other fields fall back to `null`.

**Alternative rejected:** deriving stage from the most recent `stage_start` in `events.jsonl`.
Cheap but wrong under any concurrency and silently mislabels events.

### 4. Failure is swallowed at the CLI boundary

**Decision:** the record path catches every error, writes a one-line warning to stderr, and exits
**0**.

**Why:** the agent typically invokes this from within a shell step; a non-zero exit could be read
by the agent as a failed command and derail the stage, or trip a harness step-verification check.
The criterion is explicit: an I/O failure must not appear as a stage failure or blocker. Exit code
is the only channel the parent stage observes, so it must be unconditionally 0. This mirrors
`emitHumanIntervention`'s total-function contract.

### 5. Hidden, but registered

**Decision:** add a `papercut` entry to `COMMAND_REGISTRY` and to the CLI dispatch, mark the
Commander sub-command hidden so it is absent from `--help`, and do **not** add it to the
`namespaced-command-surface` in-scope operation list (no `pipeline:papercut` host entry).

**Why:** the audience is the agent, which is told the exact invocation by the injected prompt
instruction. The `pipeline:<command>` surface is the operator's menu; a command no human runs
interactively is noise there. Registry membership is still required — flag validation rejects
unregistered commands, and the registry is the single place command metadata lives.

### 6. Report window reuses the existing `--since` convention

**Decision:** `papercut report` accepts `--since <date>` / `--until <date>` as ISO-8601 dates,
matching `improve` and `scoreboard`, and filters on the event's `at` field. It scans
`.agent-pipeline/runs/*/events.jsonl` across runs, skipping unreadable or malformed lines.

**Why:** a third window syntax in one CLI is an avoidable inconsistency. Skipping malformed lines
rather than failing keeps the report usable on a repo with one truncated run directory — a report
command that dies on stale data gets abandoned.

An empty window prints `[]` and exits 0: absence of friction is a valid, meaningful answer, and
making it an error would force awkward handling in any script consuming the report.

### 7. Prompt instruction is one exported constant behind a config gate

**Decision:** export a single `PAPERCUT_INSTRUCTION` string from the prompt module. Each of the
implementing, fix, and review templates carries a `{{papercut_instruction}}` placeholder; the
builder substitutes the constant when `papercuts.enabled`, and `""` otherwise.

**Why:** `substitute()` throws on unfilled placeholders, so the placeholder must always be
supplied — the empty-string-section pattern is already the repo's answer to that. Single-sourcing
makes "the same text across all three templates" a property of the code, not of three copies that
drift; a drift-guard test in `prompt-loader.test.ts` (mirroring the surgical-fix-discipline and
verdict-schema guards) pins it.

The disabled case must be byte-identical, which means the placeholder line in each template has to
be positioned so that removing it leaves no stray blank line — asserted by a golden-output test
comparing enabled-off rendering against the pre-change fixture.

The instruction text must draw the three-way distinction explicitly, because the failure mode is
an agent filing defects as papercuts (losing review coverage — a rigor regression) or filing
papercuts as blockers (stalling runs).

## Risks / Trade-offs

- **Papercut spam.** Nothing caps volume (out of scope). Mitigation is prompt wording: papercuts
  are for friction the agent *worked around*, not for narrating progress. If volume proves a
  problem, capping is a follow-up.
- **Prompt-length pressure.** Three templates each grow by the instruction. Kept to a few lines and
  only when opted in.
- **Sink volume.** Operators with an `exclusive` sink will see a new event type. This is the
  intended behavior and is spec'd as a `configurable-event-sink` modification rather than a silent
  addition.
