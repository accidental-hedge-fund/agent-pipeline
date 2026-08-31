## 1. Red tests for the live ship-observe throw

- [x] 1.1 In `core/test/ship-adapter.test.ts`, add a real-shaped `1.40.0` hybrid-v2 `latest.json` (HMAC-pass, `pass: true`, `pack_provenance.policy_id` `factory-gate-v1-hybrid-v2`, candidate SHA equal to the train head, HMAC-covered `factory_release_binding` built with `buildFactoryReleaseUnsignedDigestBinding`) and assert `observeFrgEvidence` returns that evidence; verify the test fails today on `hybrid pack_provenance is valid only for v1.33.0; got 1.40.0`.
- [x] 1.2 Add the same accept assertion for the v1.39.16 rejection shape (`got 1.39.16`) and verify it fails on today's throw before the assertion change.
- [x] 1.3 Invert `"ship adapter never rebinds provenance-free FRG evidence to a candidate"` so post-pilot hybrid-v2 with matching binding is accepted, provenance-free / `durableCandidateGitSha` index-only is refused, and hybrid-v1 after `1.33.0` throws naming the policy id; verify the inverted test fails on today's accept of index-only SHA and reject of hybrid provenance.
- [x] 1.4 Keep existing `1.33.0` `mintHybridEvidence` accept and candidate-mismatch cases green; verify they still pass without waiting for the assertion change.

## 2. Fail-closed cases (still red until the assertion names policy/binding)

- [x] 2.1 Assert post-pilot hybrid-v2 with missing or notes-only `factory_release_binding` throws and the message names `factory_release_binding`; verify the test does not treat `pack_provenance` as the checkpoint join.
- [x] 2.2 Assert a checkpoint-mismatched binding (candidate SHA, `frg_run_id`, or artifact digest) throws and the message names the mismatched field from `unsignedDigestBindingMismatch`; verify a matching binding on the same artifact is not required for this case to fail.
- [x] 2.3 Assert unknown `policy_id` and post-pilot `factory-gate-v1-hybrid-v1` throw naming the policy id; verify invalid HMAC remains observe-null via `observeReleaseEligibleFrgEvidence`, and repository / base / candidate mismatch after an eligible read still throws.

## 3. Assertion and observe wiring

- [x] 3.1 Replace `assertFrgCandidateProvenance`'s presence-based `1.33.0` pin with `policy_id` via `isFrgHybridV1PolicyId` / `isFrgHybridV2PolicyId`; verify tasks 1.1–1.2 and the hybrid-v1 fail-closed case pass.
- [x] 3.2 Remove `durableCandidateGitSha` and the `observeFrgEvidence` version-index fallback. For post-pilot eligible reads, load the closed unsigned checkpoint with `defaultResolveShipPathFromRun` + `buildFactoryReleaseUnsignedDigestBinding` (injectable through existing fs/read seams) and compare with `unsignedDigestBindingMismatch`. Verify provenance-free / index-only tests fail closed and standalone/missing checkpoint after an eligible post-pilot read throws.
- [x] 3.3 Keep `1.33.0` on the current `pack_provenance` candidate / repository / base bind (no post-pilot binding requirement). Verify task 1.4 stays green.
- [x] 3.4 Do not copy policy, manifest, fingerprint, proof-matrix, or HMAC rules into `ship-adapter.ts`; verify shared FRG validator tests in `core/test/factory-reliability-gate.test.ts` still fail closed on those defects without changes.

## 4. Host SKILL freshness and CI

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root and verify `node scripts/build.mjs --check` passes. Do not recreate `plugin/`.
- [x] 4.2 Run `npm run ci` from the repo root and fix failures until green.
