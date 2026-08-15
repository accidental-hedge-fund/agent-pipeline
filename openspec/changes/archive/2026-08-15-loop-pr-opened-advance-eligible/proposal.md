## Why

`pipeline single` / durable loop can leave an item permanently undriven when reconcile lands the ledger at `pr_opened` for an **intake-ready** issue (`pipeline:ready`) with an open PR and green checks. `computeNextAction` correctly advertises `advance`, but the scheduler only starts `pending` and the supervisor only re-dispatches `in_progress`. Mid-flight heal (#712) does not apply to stage `ready`, so the item is not done, not pending, and never dispatched — six `no_eligible_item` no-ops end in `supervisor_no_progress` with `dispatched: 0`. Live: issue #1065 / PR #1066 on run `loop-7273cc94a8b66cb2` (2026-08-14). Grill-lock: `pipeline:ready` is intake-ready, not finished; open PR + `pr_opened` + not ready-to-deploy must advance.

## What Changes

- Treat **not ready-to-deploy + open PR + ledger `pr_opened`** as **advance-eligible** work (class fix, not a path-local mole for issue #1065 alone).
- Extend reconciliation so stranded `pr_opened` items that still need advance (open PR, no `pipeline:ready-to-deploy` / `ready_label_present`) are restored to a dispatchable local state (`in_progress`) for normal supervisor re-dispatch — generalizing the #712 mid-flight heal to the intake-ready / non-mid-flight residual #712 explicitly left as a dead `advance` advertisement.
- Preserve terminal catch-up: `ready_label_present` (R2D) still repair-forwards to ledger `ready`; merged PR still catches up to `merged`. Do not heal `needs-human` into re-dispatch.
- Supervisor / no-progress law: a cycle or run MUST NOT terminate as `supervisor_no_progress` when any active item’s reconciled `next_actions` value is `advance` (or when such work remains unrepaired into a dispatchable path). Observed acceptance: intake-ready + open PR + `pr_opened` → `dispatched >= 1`.
- Regression fixtures: (1) intake-ready + open PR + `pr_opened` dispatches advance; (2) `next_actions: advance` never ends as `supervisor_no_progress`. Unit tests via injected deps; `npm run ci` green.
- **No** auto-merge; **no** review-policy demotion; **no** redefinition of `pipeline:ready` as ready-to-deploy; **no** admitting `pr_opened` into the `pending` scheduler frontier as a substitute for a dispatchable local state.

## Acceptance criteria

- [ ] Fixture: issue/item with intake-ready stage (`pipeline:ready` / `pipeline_stage` `ready`), open PR, checks `success`, ledger state `pr_opened`, and `ready_label_present` false → one supervisor cycle (after reconcile) dispatches advance through `pipeline/loop-execution@1` and records `dispatched >= 1` (execution call trace, not only ledger state).
- [ ] Fixture: reconciled `next_actions` contains `advance` for a non-done item → the run MUST NOT stop with reason `supervisor_no_progress` solely from consecutive `no_eligible_item` / no-progress cycles while that `advance` remains the computed next action (or while the item is still advance-eligible and unrepaired).
- [ ] `ready_label_present` true (R2D) on open PR still catch-ups to ledger `ready` and does **not** re-dispatch as mid-flight advance work.
- [ ] Merged PR still catch-ups to `merged`; `needs-human` is not healed into re-dispatch.
- [ ] Existing mid-flight heal (#712) still restores `pr_opened` + mid-flight open PR → `in_progress` and re-dispatches.
- [ ] #511 non-mid-flight open-PR catch-up to `pr_opened` from local states remains allowed, but such items MUST NOT remain stranded with only non-consuming `next_actions.advance` after a subsequent reconcile when still not R2D.
- [ ] Unit tests inject observe/store/supervisor deps only (no real network, git, or subprocess); at least one regression fails without the fix.
- [ ] `openspec validate loop-pr-opened-advance-eligible` passes; after implementation, `npm run ci` green and `plugin/` regenerated when `core/` changes.

## Capabilities

### New Capabilities

- _(none)_ — correction to existing reconciliation + supervisor eligibility / no-progress law.

### Modified Capabilities

- `durable-run-reconciliation`: expand stranded-`pr_opened` restore so open PR + not ready-to-deploy (not only mid-flight stage) yields a dispatchable local state; keep R2D/merged terminal catch-up and needs-human exclusion.
- `durable-loop-supervisor`: dispatch advance-eligible restored items; forbid `supervisor_no_progress` when `next_actions` still says `advance` for unrepaired advance-eligible work.

## Impact

- `core/scripts/loop/reconcile.ts` — heal / restore branch for advance-still-needed `pr_opened` (class generalization of mid-flight heal).
- `core/scripts/loop/supervisor.ts` — re-dispatch path reuse; no-progress / stop guard when `next_actions` is `advance`.
- Possibly pure helper colocated with mid-flight predicate (`loop/precondition.ts`) for “advance still needed / not terminal off-ramp.”
- `core/test/loop-reconcile.test.ts`, `core/test/loop-supervisor.test.ts` — intake-ready + `pr_opened` dispatch fixture; `next_actions: advance` ≠ `supervisor_no_progress`.
- OpenSpec deltas only under this change during implementation; regenerate `plugin/` after any `core/` edit.
- Live recovery: next reconcile on affected runs heals stranded intake-ready `pr_opened` items and continues advance toward `pipeline:ready-to-deploy` (never merges).
