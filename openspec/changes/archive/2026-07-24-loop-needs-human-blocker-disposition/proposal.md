## Why

The second live in-repo supervisor run (`loop-07d05fcd68f7db98`, milestone
`v1.27.0 — Trace-Driven Eval Engineering`, 2026-07-24) drove #535 end-to-end to
`pipeline:ready-to-deploy` (PR #569) — the happy path works. On the next cycle #536
blocked at plan-review with the **well-known retryable format failure** `Plan revision
output is missing required ## Feedback Incorporated section`. The correct disposition of
that blocker is a needs-human hold: the standard operator remediation is a one-line
`pipeline unblock` + re-run. Instead:

1. The supervisor's dispatch-outcome mapping binned the blocked item's outcome as
   `failed`, and Pass 2's catch-all classified `failed` as the `workflow-engine-defect`
   blocker class — whose default recovery policy is `run_fatal`.
2. The whole run **terminally stopped** on #536 (`stop: {reason: run_fatal, item_id:
   536, theme: workflow-engine-defect}`), even though a plan-review format flake is not an
   engine defect and is routinely cleared by a human unblock.
3. Worse, the terminal stop **silently discarded an outstanding ready hold**: ledger item
   #535 was sitting at `ready` with PR #569 open and unmerged, and neither the stop record
   nor the `pipeline loop` CLI output named it. An operator reading the stop had no signal
   that a ready-to-deploy PR was stranded.

This is the sibling of #568 (`loop-precondition-stage-gate`): there a *pre-pipeline*
no-op was misclassified as `workflow-engine-defect`/`run_fatal`; here a *needs-human /
retryable* pipeline blocker is misclassified the same way. Both stem from Pass 2 treating
its `failed` bucket as a genuine-defect catch-all. Even the supervisor's existing
`blocked_needs_human` path is wrong for this: it routes to the `missing-authority` blocker
class, which is a terminal `human_authority`/`run_fatal` stop — not the non-terminal
`paused/waiting` hold (`hold_outstanding=true`) that a recoverable, human-unblockable
pipeline blocker deserves.

## What Changes

- **A needs-human / retryable pipeline blocker becomes a hold, never a run-fatal engine
  defect.** When per-item execution leaves an item at a recoverable pipeline blocker
  (the issue carries `pipeline:blocked` — the human-unblockable disposition), the
  supervisor SHALL record a **needs-human hold** (the item enters `paused/waiting`, the
  run reports `hold_outstanding=true` and pauses) rather than classifying it under
  `workflow-engine-defect` / `run_fatal`. This covers both the direct
  `blocked_needs_human` outcome and — as defense in depth mirroring #568 — a `failed`
  outcome whose live issue is nonetheless observed at `pipeline:blocked`. A genuine engine
  defect (a rejected/crashed dispatch, or an unrecognized terminal outcome with the item
  at no `pipeline:blocked` state) is unaffected and still classified
  `workflow-engine-defect` with its `run_fatal` policy intact.
- **A run stop never silently strands a ready hold.** Whenever the supervisor records any
  terminal stop while one or more items are in the `ready` state
  (`pipeline:ready-to-deploy`, awaiting the human merge the pipeline never performs), the
  stop record SHALL enumerate those outstanding ready item ids, and the `pipeline loop`
  CLI output SHALL name them, so an operator is never left unaware that a ready-to-deploy
  PR is stranded when the run stopped.

## Capabilities

### New Capabilities

- `loop-needs-human-blocker-disposition`: a per-item pipeline blocker whose disposition is
  "needs human answer / unblock" (observed as `pipeline:blocked`) is recorded as a
  non-terminal needs-human hold (`hold_outstanding=true`), never as
  `workflow-engine-defect` / `run_fatal`; and any terminal run stop discloses every
  outstanding `ready` item in both the durable stop record and the `pipeline loop` CLI
  output.

### Modified Capabilities

<!-- none: the new capability adds behavior alongside the existing supervisor,
     blocker-classification, and pause/authority specs without changing their stated
     requirements. The genuine-defect `workflow-engine-defect`/`run_fatal` policy and the
     never-merge boundary are unchanged. -->

## Impact

- `core/scripts/loop/supervisor.ts` — Pass 2 dispatch-outcome classification: route
  `blocked_needs_human` (and a `failed` outcome observed at `pipeline:blocked`) to the
  pause/hold path instead of the `missing-authority` / `workflow-engine-defect` block
  paths; and enumerate outstanding `ready` items when recording any stop.
- `core/scripts/pipeline.ts` — the `pipeline loop` result surface: include the outstanding
  ready item ids in the emitted JSON.
- `core/scripts/loop/types.ts` / `loop/store.ts` — the `LoopStopRecord` gains an
  `outstanding_ready` field carrying the ready item ids captured at stop time.
- No change to the `DurableBlockerClass` enum, the `run_fatal` policy for genuine engine
  defects, or the pipeline's never-merge boundary.
