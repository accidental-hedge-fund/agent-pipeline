## Why

`pipeline loop --resume <run-id>` on a run that already recorded `stop.reason = run_fatal` re-observes that stop and exits with `resumed: true` and `dispatched: 0`. It does not re-drive remaining items. It does not refuse with the fatal time, theme, and a recovery command. An operator who fixed a transient environment cause (for example doctor `worktree-clean` on the control checkout) cannot continue the same pack. The only workaround is a new run id (`factory-release prepare` minted `loop-7304195c1fee65d7` after `loop-68575cf7a09c849c` died at 2026-08-27T15:27:13Z).

This is a controller hole, not a pack-loop mole. **Class:** operator `--resume` of a terminal `run_fatal` is a request to re-evaluate live truth at the same run id. **Site:** FRG pack `loop-68575cf7a09c849c` after a `workflow-engine-defect` doctor failure. The next identical fatal (any selector, any pack) must hit the same resume gate.

## What Changes

- On `--resume <run-id>` of a run whose ledger carries `stop.reason = run_fatal`, the supervisor SHALL run a resume-time eligibility check against live item identity (label admitted, not done/abandoned, no current human-authority hold).
- When at least one outstanding item is still valid, the supervisor SHALL supersede that `run_fatal` stop and re-drive those items through a fresh preflight at the **same** run id. It SHALL NOT mint a replacement run.
- When no outstanding item is valid, the command SHALL refuse with a distinct error that names the recorded fatal `time`, `theme`, `item_id` (when present), and the recommended next command. It SHALL NOT print the terminal drive summary with `resumed: true` and `dispatched: 0`.
- Live-drive `run_fatal` classification is unchanged. The supervisor SHALL NOT auto-retry inside a dead process. Native-`/goal` mandate stays.
- Regression tests SHALL fail if a stale transient `run_fatal` plus valid outstanding items resumes to zero dispatches with no refusal.

**BREAKING:** none. `--resume` of a non-`run_fatal` stop, live-holder refusal, and live-drive fatal policy stay as they are.

## Capabilities

### New Capabilities

<!-- None. Resume-after-fatal is supervisor/engine/store law, not a new family. -->

### Modified Capabilities

- `durable-loop-supervisor`: Operator `--resume` of a `run_fatal` stop SHALL re-drive valid outstanding items at the same run id or refuse distinctly. It SHALL NOT silently re-emit the prior stop as a successful zero-dispatch resume.
- `durable-loop-engine`: A terminal `run_fatal` stop SHALL NOT block every later transition after an operator `--resume` supersedes it. Other stop reasons keep the refuse-all rule.
- `durable-loop-store`: Superseding a `run_fatal` stop SHALL clear `ledger.stop` under the lock, append an event that preserves the prior stop record, and allow a later distinct stop event if the re-drive fatals again. The original stop event SHALL NOT be rewritten.

## Acceptance criteria

- [ ] `pipeline loop --resume <run-id>` (or `driveSupervisor({ resume: true })`) on a ledger whose `stop.reason` is `run_fatal` and whose outstanding items are still valid (admitted pipeline label, not done/abandoned, no current human-authority hold) calls the item-dispatch seam for at least one of those items at the **same** `run_id`.
- [ ] That re-drive does not create a second run directory or a new run id. Fresh preflight/reconcile runs after the stop is superseded and before dispatch.
- [ ] The same resume, when no outstanding item is valid, exits as a distinct refusal (`kind: "error"` or equivalent non-success envelope). The message includes the recorded stop `time`, `theme`, and the recommended next command. It does not print the terminal drive summary with `resumed: true` and `dispatched: 0`.
- [ ] A live supervisor that first records `run_fatal` still stops the run under existing recovery policy. Classification of `workflow-engine-defect` as `run_fatal` does not change. No auto-retry occurs without a new `--resume` invocation.
- [ ] A unit test with injected store/observe/dispatch seams (no real network, git, or subprocess) fails against current code if a run with a stale `run_fatal` stop, valid outstanding items, and a succeeding dispatch fake exits with `dispatched: 0` and no refusal. A second unit test fails against current code if a `run_fatal` resume with no valid outstanding item prints `resumed: true` / `dispatched: 0` instead of the distinct refusal.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `openspec validate loop-resume-after-run-fatal` and `npm run ci` are green.

## Impact

- `core/scripts/loop/supervisor.ts` `driveSupervisor` / `runSupervisorCycle`: today a persisted `ledger.stop` returns on the first cycle with no dispatch. Resume must gate `run_fatal` before that early return.
- `core/scripts/loop/reconcile.ts` and `core/scripts/loop/recovery.ts`: `LoopError("stop")` on any ledger stop blocks the resume reconcile. After supersede, reconcile and transitions must proceed.
- `core/scripts/loop/store.ts` / ledger: clear `stop` under the lock; append a supersede event; keep the original `loop_run_stopped` line.
- `core/scripts/pipeline.ts` loop engine: map ineligible `run_fatal` resume to a `kind: "error"` refusal rather than the terminal summary JSON.
- Tests in `core/test/loop-supervisor.test.ts` (and engine/store tests if stop-supersede is extracted). Injected deps only.
- Generated `plugin/` after any `core/` edit.
- Does not: change `run_fatal` policy flags; auto-retry a dead supervisor; add a merge stage; reverse papercut backlog policy; fall back to native `/goal`.
