## Why

v1.39.15 candidate `factory-release prepare` wrote the pack-loop contract with recovery recipe `publish_unpublished_stage_commit`. The nested pack loop then exec'd PATH `pipeline` (production pin 1.39.14) unless `PIPELINE_BIN` was set. Pin 1.39.14 `compileRecoveryPolicy` threw `recovery policy for "workflow-engine-defect" names a recipe outside the permitted recovery-recipe catalogue`. `--engine-track candidate` was already on the argv; that flag is doctor/soak intent and does not select the binary. Spawn used `stdio: "ignore"`, so ship never saw stderr. OS `spawn` still succeeded, so `dispatch_state` became `"dispatched"`. Re-spawn only runs when state is `"bound"`. The child was dead. `classifyBoundPackLoopLiveness` returned `"live"` because the ledger had no `stop` and events were not terminal. Ship waited on a dead pack for hours.

#1151 already required FRG/release/tag to run the candidate engine. Candidate **prepare** did. The **pack loop** still ran the pin. The closed catalogue is correct. Mixed-binary spawn is the defect.

This is a **class** fix, not a 1.39.15 mole. The class is: a child that must interpret a contract written by candidate SHA `C` SHALL exec that same candidate engine; OS accept is not dispatch; a non-terminal ledger is not liveness. After this change, the next pin≠candidate ship that adds a recovery recipe does not need a new mole issue.

## What Changes

- **Candidate spawn, not PATH pin.** `defaultSpawnCandidateLoop` / `productionDispatchPackLoop` SHALL exec the same verified candidate launcher that ran `factory-release prepare` (absolute executable, argv, candidate SHA). PATH `pipeline` and `PIPELINE_BIN` SHALL NOT be production fallbacks when pin SHA ≠ candidate SHA, even when `PIPELINE_BIN` is unset.
- **`--engine-track candidate` is not a binary selector.** It stays intent and diagnostic metadata. The spawn site SHALL take an explicit candidate invocation from the resolved candidate engine.
- **Dispatch acknowledgement is `loop_run_handoff`, not OS accept.** Persist request binding as `"bound"` before spawn. Do not persist `"dispatched"` because the OS accepted the child. Validate the typed `loop_run_handoff` (loop ID, absolute artifact paths, matching `supervisor.json` process identity) after the child acquires the exact loop lock, then mark `"dispatched"`.
- **Pre-handoff child exit fails closed.** A non-zero exit before the first valid handoff is terminal and is not retried. Reconcile a persisted `"bound"` state before spawning: adopt a valid existing holder, observe an in-window startup, fail closed on a proven pre-handoff failure. Never blindly create a second child. OS spawn reject (child never started, e.g. ENOENT) may still leave `"bound"` so a later invoke can retry the same `loop_run_id`.
- **Acknowledged liveness is process identity plus a fresh heartbeat.** After acknowledgement, liveness requires the exact PID, process-start identity, boot identity, and a fresh heartbeat for the exact loop. A non-terminal ledger alone SHALL NOT prove live. False `live` SHALL NOT disable the wait cap. Unreadable identity evidence gets the bounded observation window, then fails closed with a typed observer or identity error. It does not authorize resume.
- **One bounded resume after acknowledged death.** If an acknowledged process dies while the run remains resumable and non-terminal, allow one durably recorded resume for that exact loop and failed process identity. The resumed process MUST publish a new valid handoff. A second liveness loss is terminal.
- **Periodic supervisor heartbeat.** The supervisor SHALL publish a process heartbeat independently of cycle completion. Cadence and stale threshold are versioned engine safety invariants that repository configuration cannot weaken.
- **Visible stderr.** Pack-loop spawn SHALL NOT use `stdio: "ignore"` for the child's stderr. Capture bounded, redacted child stderr in pipeline-owned evidence. Ship `last_error` SHALL include the exit status, a safe excerpt, and the evidence location.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `factory-two-track-engine-pinning`: Ship-end pack-loop spawn SHALL exec the resolved candidate launcher. `--engine-track candidate` SHALL NOT select the binary. PATH `pipeline` and `PIPELINE_BIN` SHALL NOT be production fallbacks for that child.
- `factory-reliability-gate`: Request-bound pack dispatch SHALL persist `"bound"` before spawn, acknowledge with `loop_run_handoff`, and only then persist `"dispatched"`. Pre-handoff non-zero exit is terminal. Shared composer wait/liveness SHALL use acknowledged-process identity plus a fresh heartbeat, not a non-terminal ledger.
- `release-sub-command`: Candidate-native `factory-release prepare` SHALL spawn the pack loop with the same candidate invocation that wrote the contract, and SHALL NOT treat OS accept as dispatched.
- `loop-early-run-handoff`: Pack-loop dispatch SHALL consume `loop_run_handoff` as the dispatch acknowledgement. Validate loop ID, absolute paths, and matching `supervisor.json` process identity.
- `durable-loop-supervisor`: Heartbeat SHALL refresh on a periodic process cadence independent of cycle completion. After an acknowledged pack-loop process dies while the run is resumable, allow one recorded resume for that exact loop and failed process identity.
- `ship-coordinator`: In-engine FRG pack wait SHALL use acknowledged-process liveness. False `live` from a dead pid plus a non-terminal ledger SHALL NOT disable the wait cap.
- `tugboat-thin-ship`: Tugboat FRG pack wait and pack-fail wait-budget SHALL use the same acknowledged-process liveness classifier.
- `supervisor-ship-playbook`: Playbook-inherited wait helpers SHALL use that same classifier. Unreadable identity SHALL NOT remain wait-continue after the observation window.

## Impact

- `core/scripts/factory-release-prepare.ts` — `defaultSpawnCandidateLoop`, `productionDispatchPackLoop`, `isPendingLoopDispatch`, `CandidateLoopSpawn` stdio, binding `"bound"` vs `"dispatched"`.
- `core/scripts/ship-end-candidate.ts` — reuse `resolveCandidateEngine` (absolute `launcherPath`, candidate SHA). Do not fall back to PATH `pipeline`.
- `core/scripts/stages/ship-adapter.ts` — `classifyBoundPackLoopLiveness` / `probeBoundPackLoopLive`; ship `last_error` for pre-handoff and dead-pack diagnostics.
- `core/scripts/loop/handoff.ts` / `core/scripts/loop/supervisor.ts` — consume `loop_run_handoff`; periodic `heartbeat_at`; `supervisor.json` process identity.
- `core/scripts/loop/types.ts` — heartbeat / resume-record fields if the durable record needs an explicit one-resume marker.
- Tests: `core/test/factory-release-prepare.test.ts`, `core/test/ship-adapter.test.ts`, plus supervisor heartbeat tests. Inject I/O. No real network, git, or subprocess.
- Generated `plugin/` after any later `core/` edit. This planning change does not edit `core/`.
- Docs: `--engine-track candidate` remains doctor/soak intent, not a binary selector. No `--skip-frg` restore. No `auto_merge`.

## Acceptance Criteria

- [ ] When pin SHA `P` ≠ candidate SHA `C`, pack-loop spawn execs the candidate launcher for `C` even when `PIPELINE_BIN` is unset. It does not exec PATH `pipeline` / pin `P`.
- [ ] `--engine-track candidate` on the child argv does not select the binary. Spawn takes an explicit candidate executable, argv, and SHA from the resolved candidate engine.
- [ ] Candidate prepare that writes recovery recipe `publish_unpublished_stage_commit` into the contract does not spawn a pin catalogue that rejects that recipe.
- [ ] Binding persists `"bound"` before spawn. `"dispatched"` is persisted only after a valid `loop_run_handoff` for the exact loop, with absolute artifact paths and matching `supervisor.json` process identity.
- [ ] A pack child that exits non-zero before the first valid handoff does not leave `dispatch_state: "dispatched"` with no retry path that can succeed. That tick fails closed. The child exit and stderr surface in ship `last_error`.
- [ ] `classifyBoundPackLoopLiveness` does not return `"live"` for a dead-or-missing lock pid plus a non-terminal ledger that has never dispatched an item, or whose supervisor heartbeat is stale.
- [ ] False `"live"` does not disable the FRG pack wait cap. A dead pack does not stall ship for hours.
- [ ] Pack-loop spawn does not use `stdio: "ignore"` for child stderr. Bounded redacted stderr lives in pipeline-owned evidence. `last_error` names exit status, a safe excerpt, and the evidence location.
- [ ] After acknowledgement, one durably recorded resume is allowed for that exact loop and failed process identity. A second liveness loss is terminal. Unreadable identity does not authorize resume.
- [ ] Supervisor heartbeat advances during a long in-flight cycle, not only after cycle completion. Repository config cannot weaken the engine stale threshold.
- [ ] A unit test fails if candidate prepare writes `publish_unpublished_stage_commit` into the contract and the spawned loop binary is the pin catalogue that rejects that recipe.
- [ ] A unit test fails if dead pid + no `ledger.stop` + no terminal events classifies as `"live"`.
- [ ] Tests cover candidate-versus-pin execution, pre-handoff failure, the spawn-before-handoff crash window, PID reuse, periodic heartbeat freshness during long work, one-resume enforcement, unreadable authority evidence, diagnostic propagation, and false-live rejection. Tests inject I/O.
- [ ] After any later `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change. `npm run ci` is green.

## Non-goals

- Removing `publish_unpublished_stage_commit` from the candidate catalogue
- Making `--engine-track candidate` skip doctor
- Cross-host locks
- Merging inside advance/loop
- Restoring `--skip-frg` as the ship path
- Changing the closed recovery-recipe catalogue policy
