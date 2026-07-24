# Tasks

## Acceptance criteria

- [ ] A dispatch outcome of "blocked at plan-review: `Plan revision output is missing
      required ## Feedback Incorporated section`" (observed live as `pipeline:blocked`) is
      recorded as a non-terminal needs-human hold: the item enters `paused/waiting`, the
      run reports `hold_outstanding=true` and pauses, and no terminal run stop is recorded.
- [ ] Such a blocker is NEVER classified under `workflow-engine-defect` and NEVER records a
      `run_fatal` (or `human_authority`) run stop.
- [ ] Generally, any per-item pipeline blocker whose disposition is "needs human answer /
      unblock" (observed as `pipeline:blocked`) maps to the needs-human hold or a
      retry-budgeted class — never `workflow-engine-defect` / `run_fatal`.
- [ ] A genuine engine defect (rejected/crashed dispatch, or an unrecognized terminal
      outcome with the item at no `pipeline:blocked` state) is still classified
      `workflow-engine-defect` with its `run_fatal` policy intact.
- [ ] When the supervisor records any terminal stop while one or more items are in the
      `ready` state, the durable stop record enumerates those outstanding ready item ids.
- [ ] The `pipeline loop` CLI output names the outstanding ready item ids whenever a stop
      is reported alongside one or more ready items.
- [ ] Regression test: a run with one item at `ready` and a sibling whose dispatch reports
      "blocked at plan-review: missing required section" produces a needs-human hold (not a
      terminal stop); the ready sibling's state and its disclosure survive. The test bites
      (fails on the pre-fix classification of the blocked item as `workflow-engine-defect`
      / `run_fatal` and on the missing ready disclosure).
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Implementation

1. [ ] In supervisor Pass 2 (`core/scripts/loop/supervisor.ts`), route the
       `blocked_needs_human` outcome to the pause/hold path (`pauseItem` / `waitItem` with
       a human-input request) so the item enters `paused/waiting` and the cycle reports
       `holdOutstanding=true` — not the `missing-authority` / `human_authority` terminal
       stop it currently records.
2. [ ] Add the needs-human blocker-disposition safety net (mirroring #568's precondition
       no-op net): before classifying a `failed` outcome as `workflow-engine-defect`,
       consult the live issue via the existing observe seam; if it carries
       `pipeline:blocked` (a recoverable, human-unblockable disposition) with no genuine
       dispatch crash/rejection, treat it as `blocked_needs_human` → needs-human hold.
       Reserve `workflow-engine-defect` / `run_fatal` for a rejected/crashed dispatch or an
       unrecognized terminal outcome with the item at no `pipeline:blocked` state.
3. [ ] Add an `outstanding_ready: string[]` field to `LoopStopRecord` in `loop/types.ts`
       and persist/read it through `loop/store.ts`. Populate it — from the ledger's current
       `ready` items — at the moment any terminal stop is recorded (the block-induced stop
       in `recovery.ts`, the deadlock/no-progress/cycle-cap stops in `supervisor.ts`).
4. [ ] Surface the outstanding ready ids in the `pipeline loop` result JSON emitted by
       `core/scripts/pipeline.ts` and in the supervisor's action-evidence / `--audit`
       output so the disclosure is both machine-readable and visible to an operator.
5. [ ] Tests (co-located `*.test.ts`, dependency-seam fakes, no real network/git/subprocess):
       - [ ] Regression: a `ready` item + a sibling dispatched to a `pipeline:blocked`
             plan-review format blocker — the sibling holds (`hold_outstanding=true`), no
             terminal stop, and the ready sibling is preserved and disclosed.
       - [ ] A `blocked_needs_human` outcome enters `paused/waiting`, not a
             `human_authority` / `workflow-engine-defect` stop.
       - [ ] A `failed` outcome observed at `pipeline:blocked` is routed to the needs-human
             hold, not `workflow-engine-defect`.
       - [ ] A genuine defect (rejected/crashed dispatch; unrecognized outcome at no
             `pipeline:blocked` state) still maps to `workflow-engine-defect` / `run_fatal`.
       - [ ] Any terminal stop recorded while an item is `ready` carries `outstanding_ready`
             naming that item, and the CLI output names it.
6. [ ] Run `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the
       same change.
7. [ ] Run `npm run ci` from repo root; treat red as not-done.
