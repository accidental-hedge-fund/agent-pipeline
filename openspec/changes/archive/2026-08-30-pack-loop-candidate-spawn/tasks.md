## 1. Candidate invocation + handoff state

- [ ] 1.1 Add `CandidateInvocation` (absolute `executable`, frozen `argv`, 40-hex `candidateSha`) built from `resolveCandidateEngine`; fail closed if missing or mismatched. Verify a unit test fails if spawn rebuilds the binary from PATH, `PIPELINE_BIN`, `process.argv`, or `--engine-track`
- [ ] 1.2 Add a unit test that candidate prepare writes recipe `publish_unpublished_stage_commit` into the contract, PATH `pipeline` is pin catalogue `P` that rejects that recipe, `PIPELINE_BIN` is unset, and spawn records the **actual executable**; verify the test fails while `defaultSpawnCandidateLoop` execs PATH `pipeline` / `P`
- [ ] 1.3 Thread `CandidateInvocation` into `defaultSpawnCandidateLoop` / `productionDispatchPackLoop` / `defaultResumeBoundPackLoop`; verify test 1.2 turns green
- [ ] 1.4 Expand binding `dispatch_state` to `bound | starting | dispatched | failed`; persist `observation_deadline` and `spawn_attempt` evidence; treat OS accept as `starting`, not `dispatched`
- [ ] 1.5 Persist a durable atomic `loop-run-handoff.json` from `onRunReady` (token-guarded store write); validate exact `run_id`, realpath-contained `run_dir`/`events`, `candidate_sha`, and matching `supervisor.json` pid/start/boot before `dispatched`
- [ ] 1.6 Drain stdout/stderr pipes; redact with `redactSecrets`+`sanitize`; bound 16 KiB head + 16 KiB tail; persist mode `0600`; on evidence-write failure still fail closed and name the write error in `last_error`
- [ ] 1.7 Pre-handoff exit `0` and exit `1`, crash after OS accept, and handoff SHA mismatch all persist `failed` and do not retry; OS spawn throw/ENOENT leaves `bound`. A mismatched or malformed handoff SHALL stop the spawned child and close owned pipes before return. Resume OS accept SHALL persist `starting` (same protocol as initial spawn) so a later invoke observes and does not spawn a second child.
- [ ] 1.8 Reconcile before spawn: adopt valid dispatched holder, observe in-window `starting`, fail closed on `failed`, retry only `bound`; verify concurrent prepare does not spawn a second child
- [ ] 1.9 Rewrite `captured.command === "/opt/pipeline"` tests in `core/test/factory-release-prepare.test.ts`; keep `sanitizeCandidateLoopEnv` FRG-strip tests green
- [ ] 1.10 Keep `--engine-track candidate` on argv as intent metadata only; verify docs/spawn comments do not treat it as the binary selector

## 2. Heartbeat + liveness

- [ ] 2.1 Add engine constants `PACK_LOOP_HEARTBEAT_CADENCE_MS = 5000` and `PACK_LOOP_HEARTBEAT_STALE_MS = 30000`; clamp any repo config that tries to weaken them; inject fake clock + `setHeartbeatInterval` seam; clear the timer in `driveSupervisor` `finally`
- [ ] 2.2 Refresh `heartbeat_at` on that cadence during an in-flight cycle (still refresh on cycle end); verify a test fails if only cycle-end refresh exists
- [ ] 2.3 Add `core/scripts/loop/pack-loop-liveness.ts` producing `PackLoopLivenessStatus`; live requires handoff + exact pid + start/boot identity + fresh heartbeat. Missing heartbeat is not-live; malformed/future heartbeat is unknown then failed
- [ ] 2.4 Verify a unit test fails if dead-or-missing lock pid + present ledger with no `stop` + non-terminal events classifies as `"live"`
- [ ] 2.5 PID reuse without matching start/boot is not live; unreadable identity is unknown inside the window and failed after it; unreadable identity does not increment `resume_count`
- [ ] 2.6 Persist lineage-scoped `resume_count` on the binding; first acknowledged death resumes once with the same `CandidateInvocation` and a new handoff; a second liveness loss (new PID included) is terminal

## 3. Composer migrations

- [ ] 3.1 Embed `liveness: PackLoopLivenessStatus` on candidate prepare `in_progress` and pre-handoff fail results; `classifyFrgPackWaitDecision` / `probeBoundPackLoopLive` consume that schema
- [ ] 3.2 Rewrite `frg_pack_loop_is_live` / Tugboat wait to read prepare JSON `liveness.status`; delete the Python ledger-or-pid copy; playbook inherits the helper
- [ ] 3.3 False live MUST NOT disable the wait cap; rewrite `core/test/ship-adapter.test.ts` and `core/test/tugboat.test.ts` cases that currently encode dead-pid + open ledger as live
- [ ] 3.4 Ship `last_error` includes exit/error, safe excerpt, and evidence path (or the evidence-write failure)
- [ ] 3.5 Keep wait-until-terminal for a truly live acknowledged process; existing live `in_progress` at cap still continues

## 4. Generated mirror / docs / CI

- [ ] 4.1 If FRG/ship/runbook text names pack-loop spawn or `--engine-track candidate`, state that the flag is not a binary selector and that the child execs the candidate launcher; do not present `PIPELINE_BIN` or PATH `pipeline` as the pin≠candidate spawn path
- [ ] 4.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes
- [ ] 4.3 Run `openspec validate pack-loop-candidate-spawn`, `git diff --check`, and `npm run ci` from the repo root; verify all are green. Do not claim a suite pass without that evidence
