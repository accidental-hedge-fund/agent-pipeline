## 1. Regression that bites today's control-HEAD stamp

- [ ] 1.1 Add a unit test in `core/test/frg-hybrid-v2-from-run.test.ts` that injects `gitHead` → pin `P`, request/binding packed candidate `C` (`P ≠ C`), and a fake Layer A probe; assert `pack_provenance.candidate_git_sha` is `C` and every probe `candidate_git_sha` is `C`. Verify the test fails on current `defaultCollectHybridV2FromRun` (it stamps `P` from `gitHead(repoDir)`). Inject I/O; no real git, network, or subprocess.

## 2. From-run collect identity

- [ ] 2.1 Load the scored loop's `factory-release-binding.json` `candidate_git_sha` (factory-release request `integrated_candidate.git_sha`) in hybrid-v2 from-run collect and use that 40-hex OID as `pack_provenance.candidate_git_sha` when present. Verify task 1.1 turns green and collect no longer uses `gitHead(repoDir)` for identity when the binding is present.
- [ ] 2.2 Fail closed on a request-bound ship-path `--from-run` score when the loop binding packed-candidate SHA is missing. Verify a unit test fails if collect falls back to control-checkout HEAD in that case. Keep unbound standalone `--from-run` (no binding) on the existing `repoDir` HEAD last resort only.
- [ ] 2.3 Wire production `factory-gate --from-run` so the collector receives the binding identity (injected in tests). Verify `runFactoryGate` collect still persists HMAC `latest.json` under control `repoDir` (evidence write root unchanged).

## 3. Layer A probes on candidate engine sources

- [ ] 3.1 Run Layer A probes against candidate engine sources for packed candidate `C`, not control HEAD `P`. Set every probe record `candidate_git_sha` to the same OID as `pack_provenance`. Fail closed rather than hash pin-source TAP and label it `C`. Verify task 1.1 still passes and a unit test fails if probe SHA ≠ provenance SHA or if probe cwd identity is `P` while provenance is `C`.

## 4. Ensure-tag pin≠candidate

- [ ] 4.1 Keep `hmacPackedCandidateGitShaFromUnknown` vs `--packed-candidate` fail-closed when HMAC is `P` and packed is `C`. Verify existing ship-adapter / factory-reliability-gate tests still throw `HMAC candidate_git_sha is not this ship's packed candidate` (or equivalent) and do not skip HMAC.
- [ ] 4.2 Add or extend a unit test that HMAC `candidate_git_sha` `C` plus `--packed-candidate` `C` is accepted while a separate control HEAD `P` is out of band. Verify the helper does not throw the packed-candidate mismatch. Do not rewrite `latest.json`. Do not require a control fast-forward.

## 5. Docs, mirror, CI

- [ ] 5.1 If the FRG runbook names how `candidate_git_sha` is chosen, state that from-run collect uses the request packed candidate, not control HEAD. Verify the runbook does not present control `git fetch`/`ff` or `--skip-frg` as the fix.
- [ ] 5.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit; verify `node scripts/build.mjs --check` passes.
- [ ] 5.3 Run `openspec validate frg-layer-a-candidate-sha-is-train-oid` and `npm run ci` from the repo root. Fix failures until green.
