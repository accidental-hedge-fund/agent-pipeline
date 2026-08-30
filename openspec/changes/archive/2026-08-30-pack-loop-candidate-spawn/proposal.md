## Why

v1.39.15 candidate `factory-release prepare` wrote the pack-loop contract with recovery recipe `publish_unpublished_stage_commit`. The nested pack loop then exec'd PATH `pipeline` (production pin 1.39.14) unless `PIPELINE_BIN` was set. Pin 1.39.14 `compileRecoveryPolicy` threw `recovery policy for "workflow-engine-defect" names a recipe outside the permitted recovery-recipe catalogue`. `--engine-track candidate` was already on the argv; that flag is doctor/soak intent and does not select the binary. Spawn used `stdio: "ignore"`, so ship never saw stderr. OS `spawn` still succeeded, so `dispatch_state` became `"dispatched"`. Re-spawn only runs when state is `"bound"`. The child was dead. `classifyBoundPackLoopLiveness` returned `"live"` because the ledger had no `stop` and events were not terminal. Ship waited on a dead pack for hours.

#1151 already required FRG/release/tag to run the candidate engine. Candidate **prepare** did. The **pack loop** still ran the pin. The closed catalogue is correct. Mixed-binary spawn is the defect.

This is a **class** fix, not a 1.39.15 mole. The class is: a child that must interpret a contract written by candidate SHA `C` SHALL exec that same candidate engine; OS accept is not dispatch; a non-terminal ledger is not liveness. After this change, the next pin≠candidate ship that adds a recovery recipe does not need a new mole issue.

## What Changes

- **Candidate spawn, not PATH pin.** Dispatch receives a typed `CandidateInvocation` (absolute executable, immutable argv, candidate SHA) from `resolveCandidateEngine`. PATH `pipeline`, `PIPELINE_BIN`, `process.argv`, and `--engine-track` SHALL NOT re-derive the binary.
- **`--engine-track candidate` is not a binary selector.** It stays intent and diagnostic metadata.
- **Durable dispatch state machine.** Persist `bound` before spawn, `starting` after OS accept (observation deadline), `dispatched` only after a valid durable `loop_run_handoff`, `failed` on any pre-handoff exit (`0` or non-zero) or mismatch.
- **Durable handoff.** Acknowledgement is atomic `loop-run-handoff.json` that survives a detached parent. Validate loop ID, candidate SHA, realpath-contained paths, matching `supervisor.json` identity.
- **Pre-handoff exit fails closed.** Exit `0` and non-zero before handoff are terminal. OS never-started (ENOENT/throw) stays `bound` and is retryable.
- **One liveness status object.** TS probe produces versioned JSON. Prepare embeds it. Ship, Tugboat, and playbook consume it. They SHALL NOT keep a ledger-derived copy.
- **One lineage-scoped resume.** `resume_count` on the loop binding. Failed process identity is audit evidence. A new PID does not mint a second grant.
- **Periodic supervisor heartbeat.** Engine constants, token-guarded atomic writes, injectable timer/clock, cleanup on drive end.
- **Visible stderr.** Drain pipes, redact, bound, persist. Evidence-write failure still reports the exit in `last_error`.

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

- `core/scripts/factory-release-prepare.ts` — `CandidateInvocation`, `defaultSpawnCandidateLoop`, `productionDispatchPackLoop`, `isPendingLoopDispatch`, four-state binding, stderr drain.
- `core/scripts/ship-end-candidate.ts` — reuse `resolveCandidateEngine` / `shipEndCliPrefix`. Do not fall back to PATH `pipeline`.
- `core/scripts/loop/pack-loop-liveness.ts` (new) — authoritative `PackLoopLivenessStatus`.
- `core/scripts/stages/ship-adapter.ts` — consume that status; ship `last_error`.
- `core/scripts/loop/handoff.ts` / `core/scripts/loop/store.ts` / `core/scripts/loop/supervisor.ts` — durable handoff write; periodic `heartbeat_at` timer seam.
- `examples/supervisor/shell/frg-pack-helpers.sh` / `tugboat.sh` — stop ledger-derived `frg_pack_loop_is_live`; read prepare JSON `liveness`.
- Tests: `core/test/factory-release-prepare.test.ts`, `core/test/ship-adapter.test.ts`, `core/test/tugboat.test.ts`, `core/test/loop-supervisor.test.ts`, new `core/test/pack-loop-liveness.test.ts`. Fake Spawn/store/clock/timer. No real network, git, or subprocess.
- Generated `plugin/` after any later `core/` edit.
- Docs: `--engine-track candidate` remains doctor/soak intent, not a binary selector. No `--skip-frg` restore. No `auto_merge`.

## Acceptance Criteria

- [ ] When pin SHA `P` ≠ candidate SHA `C`, pack-loop spawn execs the candidate launcher for `C` even when `PIPELINE_BIN` is unset. It does not exec PATH `pipeline` / pin `P`.
- [ ] `--engine-track candidate` on the child argv does not select the binary. Spawn takes a typed `CandidateInvocation` and fails closed if it is missing or SHA-mismatched.
- [ ] Candidate prepare that writes recovery recipe `publish_unpublished_stage_commit` into the contract does not spawn a pin catalogue that rejects that recipe.
- [ ] Binding persists `bound` before spawn, `starting` after OS accept, `dispatched` only after a valid durable `loop_run_handoff` (realpath-contained paths, candidate SHA, matching `supervisor.json`).
- [ ] A pack child that exits `0` or non-zero before the first valid handoff persists `failed` and does not leave `dispatch_state: "dispatched"`. That tick fails closed. The child exit and stderr surface in ship `last_error`.
- [ ] `classifyBoundPackLoopLiveness` does not return `"live"` for a dead-or-missing lock pid plus a non-terminal ledger that has never dispatched an item, or whose supervisor heartbeat is stale.
- [ ] False `"live"` does not disable the FRG pack wait cap. A dead pack does not stall ship for hours.
- [ ] Pack-loop spawn does not use `stdio: "ignore"` for child stderr. Pipes are drained. Bounded redacted stderr lives in pipeline-owned evidence. Evidence-write failure still reports the exit. `last_error` names exit status, a safe excerpt, and the evidence location.
- [ ] After acknowledgement, one lineage-scoped `resume_count` is allowed for that `loop_run_id`. A second liveness loss is terminal even with a new PID. Unreadable identity does not authorize resume.
- [ ] Supervisor heartbeat advances during a long in-flight cycle, not only after cycle completion. Repository config cannot weaken the engine stale threshold. The timer is cleared when drive ends.
- [ ] Ship, Tugboat, and playbook consume the same `PackLoopLivenessStatus` from prepare JSON. `frg_pack_loop_is_live` no longer classifies live from a non-terminal ledger.
- [ ] A unit test fails if candidate prepare writes `publish_unpublished_stage_commit` into the contract and the spawned executable is the pin launcher.
- [ ] A unit test fails if dead pid + no `ledger.stop` + no terminal events classifies as `"live"`.
- [ ] Tests cover candidate-versus-pin execution, OS spawn throw, zero and nonzero pre-handoff exits, the spawn-before-handoff crash window, handoff SHA mismatch, concurrent prepare, PID reuse, periodic heartbeat freshness during long work, malformed/future heartbeat, one-resume-then-terminal, unreadable authority evidence, diagnostic propagation, and false-live rejection. Tests inject I/O.
- [ ] After any later `core/` edit, `node scripts/build.mjs` regenerates `plugin/` in the same change. `npm run ci` is green.

## Non-goals

- Removing `publish_unpublished_stage_commit` from the candidate catalogue
- Making `--engine-track candidate` skip doctor
- Cross-host locks
- Merging inside advance/loop
- Restoring `--skip-frg` as the ship path
- Changing the closed recovery-recipe catalogue policy
