## Context

Durable loop runs already expose:

| Surface | What operators see today |
|---------|--------------------------|
| Ledger item `state` | Coarse: `pending` / `in_progress` / `blocked` / `ready` / … |
| `LoopExternalIdentity.pipeline_stage` | Stage label suffix from live GH reconciliation — refreshed on reconcile passes, not continuously during a long mid-advance wait |
| `--audit` | Process identity, `action_evidence` (dispatch/exclude/hold/noop), watchdog / no-progress, coarse position |
| Advance run `events.jsonl` | `stage_start` / `stage_complete` / `review_verdict` with real stage names and rounds |
| #667 linkage | Real advance `pipeline_run_id` + absolute `events` path on the loop trail |
| #666 `pipeline loop logs` | Dump/follow the **loop** `events.jsonl` (supervisor kinds), not a clean stage table |

Gap: during a multi-item run, `--audit` cannot answer "is `#607` at plan-review round 1 or implementing?", and following progress still means discovering the advance run-id and tailing interleaved harness `terminal.log` (or raw advance events without a loop-level table).

Hard constraints:

- Supervisor **hands off whole items** and MUST NOT own pipeline stage labels or merge (`durable-loop-supervisor`).
- Observation-only for follow/audit followers (no lock theft, no run-liveness reservation).
- Prefer injected seams; unit tests with no real network/git/subprocess.
- Rigor-preserving: no review/autonomy/state-machine changes.

## Goals / Non-Goals

**Goals:**

- Persist a first-class per-item **current-stage** projection on the durable loop run, distinct from coarse `state`.
- Update that projection on stage transitions while an item is mid-advance.
- Render a per-item stage table from `--audit`, including advance run-id drill-down when known.
- Stream whole-run structured stage-transition events via a documented `--follow` observation path without harness stdout.

**Non-Goals:**

- Supervisor writing `pipeline:*` labels or driving per-stage verbs.
- Bridging full child harness stdout into the loop stream.
- Replacing `pipeline loop logs` or advance `pipeline logs`.
- Async multi-detach concurrent advances redesign.
- Changing recovery budgets, merge barrier, or ready-to-deploy handoff.

## Decisions

### Decision 1 — Additive `current_stage` on the ledger item (not a second ledger)

**Choice:** Extend `LoopItemLedgerEntry` (or an equivalent per-item durable field written with the ledger document) with an additive stage-progress projection, for example:

| Field | Role |
|-------|------|
| `current_stage` | Pipeline stage name (label suffix or advance stage id, e.g. `implementing`, `plan-review`) |
| `current_stage_round` | Optional review/fix round when applicable |
| `current_stage_updated_at` | ISO timestamp of last transition |
| `advance_run_id` | Real advance run-store basename when known (mirror of #667 linkage for audit convenience) |

Coarse `state` remains the only field that drives scheduling / recovery / stop logic. Stage progress is **observability** only.

**Why not only project at audit time from GH labels?**

- Mid-advance, labels may lag or stay coarse; advance `stage_start` is the authoritative in-flight timeline already written by the child.
- Issue AC requires a durable signal updated on stage transition, not a live GH poll only when the operator runs `--audit`.

**Why not only project at audit time from the advance `events.jsonl`?**

- That works when linkage + the advance store still exist, but fails after cleanup, for queued items, and for operators who expect the loop run directory alone to answer "where is each item?". Durable projection on the ledger survives resume and offline audit.

**Why not replace coarse `state` with stage names?**

- Scheduling and recovery semantics are defined over the closed `LoopItemState` set; conflating them would break stop/budget rules and violate "never own stage labels."

### Decision 2 — Observe the linked advance event stream during the child wait

**Choice:** After #667 start linkage is confirmed (pinned advance run id + live `events.jsonl`), the supervisor (or a helper invoked from the dispatch wait loop) **tails or polls** that advance `events.jsonl` for stage-relevant events:

- `stage_start` → set `current_stage` to `event.stage`
- `review_verdict` → set/retain stage and `current_stage_round` from `event.round` when present
- `stage_complete` → may refine presentation; do not clear stage until a later start or terminal outcome
- terminal linkage / dispatch end → set stage to a terminal presentation consistent with outcome (e.g. `ready-to-deploy`, `blocked`) or leave last stage with coarse `state` reflecting terminal

On each **material change** of `(current_stage, current_stage_round)`, the supervisor:

1. Writes the updated ledger projection (atomic ledger write, existing store rules).
2. Appends a structured loop event (illustrative kind: `loop_item_stage_progress`) with `item_id`, stage, optional round, `advance_run_id`, and timestamp.

**Why not parse child stdout?**

- Stdio is inherited and interleaved with harness prose; parsing is fragile and is exactly the operator pain this issue removes.
- Advance events are already structured and unit-testable.

**Why not require the child to call back into the loop store?**

- Would couple advance runtime to the loop state home and break the whole-item hand-off boundary. Observation of the child's own run store preserves separation.

**Polling vs inotify/tail:** implementation may poll on a short interval during `wait` or share the follow seam used by `pipeline logs --events --follow`. Exact mechanism is an implementation detail; correctness is "updated on stage transition with bounded lag," not sub-millisecond push.

### Decision 3 — Queued / not-yet-dispatched presentation

**Choice:** Items that are `pending` (or otherwise not mid-advance) present as:

- stage: `pending` / `queued` (or omit stage and show coarse state + a clear queued note)
- advance run-id: absent or last known historical id from a prior attempt (if retained), never a fabricated live path

Next-wave vs current-wave presentation MAY use scheduler context when already available in action_evidence; not required for MVP if the table already distinguishes `pending` from an in-flight stage.

### Decision 4 — Audit renders a stage table from durable artifacts only

**Choice:** Extend `auditSupervisor` / CLI audit rendering to include a per-item stage table derived solely from the ledger (+ last linkage fields), for example:

```
#607  implementing            (advance run 607-2026-07-27T19-31-29-328Z)
#608  pending                 (queued)
#610  pending                 (queued)
```

Exact column formatting is CLI polish; required content is item id, stage presentation, and advance run-id when known. Audit remains fully read-only (existing requirement).

### Decision 5 — Follow mode streams structured loop stage events (not harness stdout)

**Choice:** Prefer extending the existing observation path:

1. **Primary:** document that whole-run stage progress is streamed by following the loop run's `events.jsonl` for `loop_item_stage_progress` (and linkage) events — via `pipeline loop logs <run-id> --events --follow` **and/or** a first-class `pipeline loop --resume <run-id> --follow` / `--audit --follow` facade that prints a **human-readable one-line rendering** of those events (and optionally historical table then tail).

2. The follower process is read-only: no durable write, no lock acquisition, no GitHub mutation, no `pipeline-starting-*.lock`.

3. Follow MUST NOT attach to per-item `terminal.log` by default.

**Why allow both `loop logs --follow` and `--audit --follow`?**

- `loop logs` already streams raw JSONL (#666). Operators still need a clean one-line stage surface without filtering JSON by hand — that is the gap `--audit --follow` / resume-follow fills.
- Implementation MAY share one pure formatter: `formatStageProgressLine(event) → string`.

**Flag allowlist:** preflight/facade must accept `--follow` only in observation combinations that do not start a mutating supervisor cycle unless `--resume` alone already means "drive the run" today. Prefer:

- `--audit --follow` → read-only follow of stage events for the resolved run
- `--resume <id> --follow` → if resume currently starts the supervisor, do **not** silently dual-purpose it; either require `--audit --follow` for observation, or define `--follow` with resume as observation-only when combined with `--audit`. **Resolve in implementation to keep resume's mutating semantics unambiguous** — recommended default: **`--audit --follow` is the observation path**; skill docs may still say "resume + follow" only if resume is not started.

Issue text allows either shape. Spec will require **at least one** documented observation follow path that streams whole-run stage transitions cleanly.

### Decision 6 — Schema compatibility

**Choice:** Additive optional fields on ledger items. Older ledgers without `current_stage` audit as "stage unknown / not recorded" rather than failing schema checks. Status and audit degrade gracefully.

### Decision 7 — Test seams

**Choice:** Pure helpers for:

- mapping advance events → stage projection deltas
- deciding whether a delta is material
- formatting audit rows and follow lines

Supervisor/dispatch tests inject a fake advance-event reader and fake store; prove regression that today's audit report lacks per-item stage fails without the fix.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Mid-wait observer races with child init | Only start observation after #667 confirms live `events.jsonl`; no fabricated live path |
| Ledger write frequency / lock contention | Update only on material stage/round change; reuse existing exclusive lock already held by supervisor |
| Stale stage after crash mid-advance | On resume/reconcile, re-read last advance events or GH `pipeline_stage` to refresh projection before next dispatch |
| Operator confuses coarse state with stage | Audit labels columns clearly; specs require both to remain distinct |
| Follow flag collides with mutating resume | Prefer `--audit --follow` as the read-only path; unit-test argv classification |
| Over-coupling to advance event type strings | Centralize mapping in one pure function; extend mapping table when new stage events appear |

## Migration Plan

1. Ship additive ledger fields + writer during dispatch wait + audit/follow rendering in one change.
2. Existing runs without fields remain readable; stage table shows unknown/pending until next advance updates them.
3. No data backfill required.
4. Rollback: optional fields ignored by older code; append-only stage events are harmless.

## Open Questions

1. **Exact CLI for follow:** ship only `--audit --follow`, or also a dedicated `pipeline loop progress <run-id> --follow`? Spec requires at least one documented path; prefer `--audit --follow` plus reuse of `loop logs` for raw JSONL.
2. **Round presentation:** combine into one string (`review (round 1)`) vs separate columns — presentation-only; durable fields keep stage + round separate.
3. **Historical multi-attempt advance run-ids:** show only latest linked id, or a short history — MVP is latest known id from current/last linkage.
