## 1. Regression tests that bite #1296

- [ ] 1.1 Add a unit test that candidate prepare writes recipe `publish_unpublished_stage_commit` into the contract, PATH `pipeline` is pin catalogue `P` that rejects that recipe, `PIPELINE_BIN` is unset, and spawn is recorded; verify the test fails while `defaultSpawnCandidateLoop` execs PATH `pipeline` / `P`
- [ ] 1.2 Add a unit test that `classifyBoundPackLoopLiveness` (or the shared classifier) receives dead-or-missing lock pid, present ledger with no `stop`, and non-terminal events; verify the test fails while the result is `"live"`
- [ ] 1.3 Add a unit test that OS `spawn` succeeds and no `loop_run_handoff` is observed; verify the test fails while `dispatch_state` becomes `"dispatched"`
- [ ] 1.4 Add a unit test that the child exits 1 before handoff with catalogue stderr; verify the test fails while liveness is `"live"` or `last_error` omits the catalogue text
- [ ] 1.5 Add a unit test that a later process reuses the numeric pid without matching boot / process-start identity; verify the test fails while liveness is `"live"`
- [ ] 1.6 Add a unit test that `supervisor.json` heartbeat is older than the engine stale threshold during an in-flight cycle; verify the test fails while liveness is `"live"`
- [ ] 1.7 Add a unit test that unreadable `supervisor.json` / lock identity does not mint a resume grant; verify the test fails if resume spawn is attempted from that evidence

## 2. Candidate invocation

- [ ] 2.1 Thread the resolved candidate launcher (absolute executable, argv, SHA `C` from `resolveCandidateEngine`) into `defaultSpawnCandidateLoop` / `productionDispatchPackLoop`; verify test 1.1 turns green and `PIPELINE_BIN` unset does not exec PATH `pipeline`
- [ ] 2.2 Keep `--engine-track candidate` on argv as intent metadata only; verify a unit test fails if docs or spawn comments treat that flag as the binary selector, and that the executable still comes from the candidate launcher
- [ ] 2.3 Keep FRG signing env stripped from the child; verify existing `sanitizeCandidateLoopEnv` tests still pass
- [ ] 2.4 Rewrite the current test that asserts `captured.command === "/opt/pipeline"` from `PIPELINE_BIN` so it asserts the candidate launcher instead; verify `npm test` no longer encodes the pin fallback

## 3. Handoff acknowledgement and bound reconciliation

- [ ] 3.1 Persist binding `"bound"` before spawn and persist `"dispatched"` only after a valid `loop_run_handoff` plus matching `supervisor.json` process identity; verify test 1.3 turns green
- [ ] 3.2 Redirect child stdout and stderr to pipeline-owned evidence files (stdin ignored); parse one `loop_run_handoff` from stdout; verify a unit test fails if `stdio` is `"ignore"` for stderr or stdout
- [ ] 3.3 Fail closed on pre-handoff non-zero exit without retry and without a second `loop_run_id`; verify test 1.4 turns green and `last_error` names exit status, a safe excerpt, and the evidence path
- [ ] 3.4 Reconcile persisted `"bound"` before spawn: adopt a valid existing holder, observe in-window startup, fail closed on proven pre-handoff failure; verify a unit test fails if a second child is spawned while a holder exists
- [ ] 3.5 Keep OS spawn never-started (ENOENT) as `"bound"` so a later invoke can retry the same `loop_run_id`; verify the existing ENOENT same-run retry test still passes

## 4. Shared liveness classifier and wait cap

- [ ] 4.1 Change the shared pack-loop liveness classifier to require acknowledged PID, process-start identity, boot identity, and a fresh heartbeat; verify tests 1.2 and 1.5 turn green
- [ ] 4.2 Apply that classifier in in-engine ship, Tugboat, and playbook wait helpers; verify a unit test fails if dead pid + open ledger still disables the wait cap
- [ ] 4.3 After the observation window, fail closed on unreadable identity with a typed observer or identity error; verify the old unreadable-at-cap-is-continue tests are replaced and the new fail-closed tests pass
- [ ] 4.4 Keep wait-until-terminal for a truly live acknowledged process; verify existing live `in_progress` at cap still continues

## 5. Periodic heartbeat and one-resume

- [ ] 5.1 Refresh supervisor `heartbeat_at` on a periodic process cadence during an in-flight cycle; verify test 1.6 turns green when the heartbeat stays fresh, and fails if only cycle-end refresh exists
- [ ] 5.2 Keep cadence and stale threshold as engine invariants that repository config cannot weaken; verify a unit test fails if a config value raises the stale threshold
- [ ] 5.3 Persist one resume grant keyed by `loop_run_id` plus failed process identity after acknowledged death while the run is resumable; verify the resumed process must emit a new handoff
- [ ] 5.4 Make a second liveness loss terminal; verify a unit test fails if a second child is spawned
- [ ] 5.5 Verify test 1.7 (unreadable identity does not grant resume) passes

## 6. Docs, mirror, and CI

- [ ] 6.1 If FRG/ship/runbook text names pack-loop spawn or `--engine-track candidate`, state that the flag is not a binary selector and that the child execs the candidate launcher; verify docs do not present `PIPELINE_BIN` or PATH `pipeline` as the pin≠candidate spawn path
- [ ] 6.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes
- [ ] 6.3 Run `openspec validate pack-loop-candidate-spawn`, `git diff --check`, and `npm run ci` from the repo root; verify all are green
