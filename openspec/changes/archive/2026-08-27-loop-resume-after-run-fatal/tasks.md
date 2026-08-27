## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected `driveSupervisor({ resume: true })` test whose ledger already has `stop.reason = run_fatal`, two contract items still pending with admitted `pipeline:ready` labels, and a dispatch fake that completes an item to done. Assert the test **fails** against current code if `dispatchItem` is never called, if a second `run_id` is created, or if the result is `resumed: true` with `dispatched: 0` and the original stop still set. No live network, git, or subprocess
- [x] 1.2 Add an injected resume test whose `run_fatal` ledger has no valid-outstanding item (all remaining items done, skipped, or under a current human-authority hold). Assert the test **fails** against current code if the drive returns the terminal summary shape with `resumed: true` and `dispatched: 0` instead of a distinct refusal, or if `dispatchItem` is called
- [x] 1.3 Add an injected resume test whose dispatch fake records a new `run_fatal` after the first re-drive call. Assert the test **fails** against current code if `dispatchItem` was not called or if the resulting stop `time` is still the superseded stop's `time`
- [x] 1.4 Add an injected test that a live (non-resume) drive still persists `stop.reason = run_fatal` for `workflow-engine-defect` under existing policy. Verify this already passes today and still passes after the resume gate lands

## 2. Resume-time eligibility classifier

- [x] 2.1 Extract a pure classifier over ledger items plus observed identities: valid-outstanding means on-contract, not done/abandoned/skipped, not a current human-authority hold, and live labels admitted by the existing loop precondition gate. Verify with unit tests for admitted pending, human-held, backlog-excluded, and done items. No I/O
- [x] 2.2 When live observation throws or returns unusable identity, the classifier/gate SHALL fail closed (not eligible). Verify an injected observe-failure fixture does not treat items as valid-outstanding

## 3. Stop supersede (store / engine)

- [x] 3.1 Under the run lock, eligible supersede writes the ledger with `stop` absent and appends one event whose payload copies the prior stop (`reason`, `time`, `theme`, `item_id`, `outstanding_ready`). Verify the original `loop_run_stopped` event still parses and is not rewritten
- [x] 3.2 After supersede, `reconcile` and an item transition succeed (no `LoopError("stop")` naming the old stop). Verify with injected store tests. Confirm task 1.1 can now pass the stop-cleared assertion once the supervisor calls this path
- [x] 3.3 Ineligible refusal does not clear `ledger.stop` and does not append a supersede event. Verify against the task 1.2 fixture
- [x] 3.4 `--resume` of a non-`run_fatal` stop does not clear that stop. Verify a `recovery_exhausted` (or `human_authority`) fixture still refuses transitions

## 4. Supervisor resume gate

- [x] 4.1 In `driveSupervisor`, after attach and before `loop_drive_started` / `onRunReady`, when `resume` is set and `stop.reason === "run_fatal"`, run the classifier. Eligible: supersede, then existing resume reconcile + cycle. Verify task 1.1 now calls `dispatchItem` at the same `run_id` and that `loop_drive_started` is emitted only after supersede
- [x] 4.2 Ineligible or observe-failure: do not emit `loop_drive_started`, do not dispatch, leave the original stop, release the lock in `finally`. Verify task 1.2
- [x] 4.3 Eligible re-drive that fatals again appends a new stop event with a new `time`. Verify task 1.3. Do not auto-retry without a new `--resume`
- [x] 4.4 `runSupervisorCycle`'s existing `ledger.stop` early return remains for a live drive that just recorded a stop, and for resume of non-`run_fatal` stops. Verify existing supervisor stop tests still pass

## 5. CLI refusal envelope

- [x] 5.1 Map ineligible `run_fatal` resume to the loop engine `kind: "error"` (or equivalent non-success) result whose message includes the recorded stop `time`, `theme`, `item_id` when present, and recommended commands (`pipeline loop --resume <run-id> --audit` and `pipeline loop --new-run`). Verify the CLI path does not print the terminal drive summary JSON with `resumed: true` and `dispatched: 0`
- [x] 5.2 Eligible re-drive still emits the existing early `loop_run_handoff` (`resumed: true`) and the existing terminal summary after the drive. Verify handoff tests still pass and that the FRG-shaped fixture's terminal summary is not a zero-dispatch echo of the old stop

## 6. Gate

- [x] 6.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 6.2 Run `openspec validate loop-resume-after-run-fatal` and `npm run ci` from the repo root. Verify both are green. Do not change `run_fatal` recovery policy flags. Do not auto-retry a dead supervisor. Do not add merge-inside-advance/loop or a native `/goal` fallback
