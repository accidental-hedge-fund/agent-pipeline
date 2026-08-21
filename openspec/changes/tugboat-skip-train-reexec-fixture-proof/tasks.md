## 1. Regression bite on parent skip-train env

- [ ] 1.1 Add a co-located check in `core/test/tugboat.test.ts` that injects parent `TUGBOAT_SKIP_TRAIN=1` (v1.39.8 release CI) into the four named spawn-real-`tugboat.sh` tests without isolation or `RUN_DIR` proof. Verify they fail with `TUGBOAT_SKIP_TRAIN without train.complete.json or train.json` (or equivalent) and do not reach the original FRG / candidate assertions
- [ ] 1.2 Keep the four original assertions in place (candidate argv vs pin argv, live-wait prepare ticks, not-live pack-fail, unavailable-engine fail-closed). Verify the test names and matchers are still those #1150 / #1151 behaviors, not skip-train-only checks

## 2. Shared fixture isolation and skip-train proof

- [ ] 2.1 Add a shared spawn-env helper used by `writeTugboatFrgFixture` and the #1151 candidate-engine tests. Omit inherited `TUGBOAT_SKIP_TRAIN` and `TUGBOAT_CANDIDATE_COMPOSER` unless the test is asserting skip-train. Keep `TUGBOAT_CANDIDATE_SHA`, `TUGBOAT_BASE_BRANCH`, `TUGBOAT_OPEN_RELEASE_PR`, and `TUGBOAT_REPOSITORY`. Verify task 1.1’s parent-env injection no longer skip-trains the first process
- [ ] 2.2 Ensure `writeTugboatFrgFixture` (and the duplicated #1151 candidate-engine spawn) leaves a skip-train proof in that ship `RUN_DIR` before candidate re-exec: non-empty `train.complete.json`, or non-empty `train.json`, or documented empty-milestone stderr. Prefer the existing `ensure_train_complete_artifact` path after fake `complete:true` train. Verify the candidate re-exec no longer prints `FAIL: TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`
- [ ] 2.3 Apply the same isolation to other spawn-real-`tugboat.sh` sites in `tugboat.test.ts` that copy `...process.env` (including the skip-frg fixtures) so a later ship CI does not need a new mole. Verify those tests still pass with parent `TUGBOAT_SKIP_TRAIN=1` injected and still assert their original skip-frg / FRG behavior

## 3. Re-exec export of supervisor state and repo dir

- [ ] 3.1 In `examples/supervisor/shell/tugboat.sh` `maybe_reexec_candidate_composer`, export `PIPELINE_SUPERVISOR_STATE` (same value as `STATE_ROOT`) and `REPO_DIR` before `exec bash "$cand"`. Keep existing skip-train and helper-bin exports. Verify `extractNamedFn` of `maybe_reexec_candidate_composer` matches those exports, and a re-exec helper fixture sees the same `RUN_DIR` proof under the exported state root
- [ ] 3.2 Do not change `skip_train_has_proof` or `ensure_train_complete_artifact`. Verify existing #1182 empty-milestone and RUN_DIR-evidence tests still pass

## 4. Gate

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 4.2 Run `openspec validate tugboat-skip-train-reexec-fixture-proof` and `npm run ci` from the repo root. Verify both are green. Verify the four named tests pass with parent skip-train env injected. Do not add `--skip-frg` as the default ship path. Do not re-implement #1181–#1183
