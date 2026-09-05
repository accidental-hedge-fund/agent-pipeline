## 1. Omitted-name set (class source)

- [x] 1.1 In `core/scripts/testgate.ts`, export the omitted-name list derived from `Object.values(CANDIDATE_PROCESS_GUARD_ENV)`, `FACTORY_CONTROL_DIR_ENV`, `PRODUCTION_PIN_ENV`, `FACTORY_PLANE_REPO_DIR_ENV`, `PIPELINE_PACK_LOOP_CANDIDATE_SHA_ENV`, plus literals `PIPELINE_CANDIDATE_ENGINE_ROOT`, `PIPELINE_STARTING_LOCK_PID`, and `ALLOW_MERGE`. Verify the export includes every name listed in the `test-build-gate` delta.
- [x] 1.2 Add a drift-guard unit test that fails if `CANDIDATE_PROCESS_GUARD_ENV` contains a name the omitted-name list does not include. Verify the test bites when that name is temporarily dropped from the list.

## 2. `runCapped` overlay: drop undefined keys

- [x] 2.1 When `opts.env` is present, drop keys whose value is `undefined` after `{ ...process.env, ...opts.env }` so they are absent from the spawn `env` object. Verify the existing papercut merge test still sees added keys and `PATH`.
- [x] 2.2 Keep the no-`opts.env` path unchanged: spawn carries no `env` key. Verify the existing `runCapped: no opts.env → spawn options carry no env key` test still passes.

## 3. `runTests` applies the overlay

- [x] 3.1 `runTests` passes `opts.env` with every omitted name set to `undefined` (do not reuse `sanitizeCandidateLoopEnv`). Verify an injected `spawnFn` sees those names absent as string values on `options.env`.
- [x] 3.2 Preserve ordinary unrelated variables. Verify the same injected spawn captures a sentinel such as `PIPELINE_TESTGATE_ENV_SENTINEL=keep-me` unchanged.
- [x] 3.3 Do not pass the overlay through harness `invoke`. Verify harness tests for no-`opts.env` and papercut identity stay green.

## 4. Spawn regression and gate mechanics

- [x] 4.1 Add a `core/test/testgate.test.ts` `runTests` + `spawnFn` regression that sets every omitted name plus the sentinel on the parent env, asserts omitted names are not string values, and asserts the sentinel is preserved. Verify the test fails if the overlay is skipped.
- [x] 4.2 Confirm existing test-gate timeout, process-group kill, and capture tests in `core/test/testgate.test.ts` still pass (including `#384` toolingError and `#173`/`#174` shell/process-group cases).

## 5. Mirror and full gate

- [x] 5.1 After `core/` edits, run `node scripts/build.mjs` and verify `--check` is clean.
- [x] 5.2 Run `openspec validate isolate-repo-test-commands-from-factory-env` and verify it passes.
- [x] 5.3 Run `npm run ci` from the repo root and verify it passes, including the new spawn isolation tests.
