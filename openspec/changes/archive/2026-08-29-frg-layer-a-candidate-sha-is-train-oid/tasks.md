## 1. Regression that bites today's control-HEAD stamp

- [x] 1.1 Add a unit test in `core/test/frg-hybrid-v2-from-run.test.ts` that injects control `repoDir` HEAD pin `P`, loop binding and/or request packed candidate `C` (`P ≠ C`), a fake Layer A `runProbe`, and `gitHead` that throws if called with `repoDir`. Assert `pack_provenance.candidate_git_sha` is `C` and every probe `candidate_git_sha` is `C`. Verify the test fails on current `defaultCollectHybridV2FromRun` (it stamps `P` from `gitHead(repoDir)`). Inject I/O; no real git, network, or subprocess.

## 2. From-run collect identity

- [x] 2.1 Add a pure identity helper (normalize with `parseExactGitSha`) and load the scored loop's `factory-release-binding.json` `candidate_git_sha` in hybrid-v2 from-run collect. When in-process prepare holds the request, pass `integrated_candidate.git_sha` into collect as well. Use the resolved OID as `pack_provenance.candidate_git_sha`. Verify task 1.1 turns green and request-bound collect does not call `gitHead(repoDir)`.
- [x] 2.2 Fail closed on request-bound ship-path `--from-run` when the loop binding file is missing, when a present request or binding SHA is malformed, or when the two parsed OIDs differ. Verify unit tests fail if collect falls back to control HEAD or to the other source in those cases, and that failure happens before probes and before evidence write. Keep unbound standalone `--from-run` (no request object, no binding file) on the existing `repoDir` HEAD last resort only.
- [x] 2.3 Wire production `factory-gate --from-run` and `defaultScoreBoundPackLoop` so the collector receives binding identity (and request SHA on the in-process path). Verify `runFactoryGate` collect still persists HMAC `latest.json` under control `repoDir` (evidence write root unchanged).

## 3. Layer A probes on candidate engine sources

- [x] 3.1 Resolve candidate engine sources for `C` with injected `resolveCandidateEngine` (`core/scripts/ship-end-candidate.ts`). Pass `engine.engineRoot` to `runProbe` as `candidateEngineDir`. Set every probe record `candidate_git_sha` to the same OID as `pack_provenance`. Fail closed when the engine cannot be resolved at `C`. Do not hash pin-source TAP from control `repoDir` and label it `C`. Verify a unit test captures the injected runner cwd/path/arguments as the candidate engine root for `C`, not control `repoDir`, and fails if probe SHA ≠ provenance SHA.

## 4. Ensure-tag pin≠candidate

- [x] 4.1 Keep `hmacPackedCandidateGitShaFromUnknown` vs `--packed-candidate` fail-closed when HMAC is `P` and packed is `C`. Verify existing ship-adapter / factory-reliability-gate tests still throw `HMAC candidate_git_sha is not this ship's packed candidate` (or equivalent) and do not skip HMAC.
- [x] 4.2 Add or extend a unit test that HMAC `candidate_git_sha` `C` plus `--packed-candidate` `C` is accepted while a separate control HEAD `P` is out of band. Verify the helper does not throw the packed-candidate mismatch. Do not rewrite `latest.json`. Do not require a control fast-forward. Do not change the comparison helper.

## 5. Docs, mirror, CI

- [x] 5.1 If the FRG runbook names how `candidate_git_sha` is chosen, state that from-run collect uses the request packed candidate / loop binding, not control HEAD. Name that request-bound collect must not fall back to `repoDir` HEAD. Verify the runbook does not present control `git fetch`/`ff` or `--skip-frg` as the fix.
- [x] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [x] 5.3 Run `openspec validate frg-layer-a-candidate-sha-is-train-oid` and `npm run ci` from the repo root. Fix failures until green. Do not claim tester-suite pass; this run has no authoritative tester-suite evidence.
