## 1. Regression tests that bite the v1.39.10 mislabel

- [x] 1.1 Add a co-located test in `core/test/tugboat.test.ts` that extracts `observe_stage_watch_pid` (and the spawn/log wiring it needs). Spawn a fixture watch that exits 1 with stderr `material filter not found on PATH: material-filter.mjs`. Assert the playbook includes that filter line and does not contain `stage-watch argv rejected`. Verify this test **fails** against current Tugboat (hardcoded `stage-watch argv rejected`, no filter line)
- [x] 1.2 Add a second co-located test that extracts `start_train_stage_watch` and passes a relative events path. Assert the playbook logs the distinct non-absolute refusal (`events path is not absolute` or equivalent), does not log `stage-watch argv rejected`, and does not spawn the watch binary. Verify this test **fails** against current Tugboat (logs `stage-watch argv rejected`)
- [x] 1.3 Keep existing `core/test/tugboat.test.ts` #1184 `--milestone` argv-reject and `--events-file` argv tests, and #1212 filter-present / missing-filter pre-spawn tests, passing. Verify those existing tests still pass

## 2. Tugboat logs the real watch fail reason

- [x] 2.1 In `examples/supervisor/shell/tugboat.sh` `observe_stage_watch_pid`, after the short observe window, if the watch pid is not live, read the spawn capture (`$RUN_DIR/stage-watch.log` or equivalent) and the wait exit status. Log `stage-watch argv rejected` only for exit 2 plus usage/parser text. Otherwise log a named failure that includes the stderr tail and/or exit status. Do not log `stage-watch started pid=…` for that spawn. Unlink the pid file. Continue train. Do not fail the ship. Verify task 1.1 now passes
- [x] 2.2 In `start_train_stage_watch`, refuse a non-absolute events path before spawn with a distinct message (`events path is not absolute` or equivalent). Do not log `stage-watch argv rejected` for that refusal. Do not spawn the watch. Continue train. Do not fail the ship. Do not change #1212 filter presentation or the pre-spawn `material filter missing` skip. Verify task 1.2 now passes

## 3. Gate

- [x] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 3.2 Run `openspec validate tugboat-stage-watch-log-real-failure` and `npm run ci` from the repo root. Verify both are green. Do not present `PIPELINE_MATERIAL_FILTER` as this issue’s fix. Do not kill or restart an in-flight ship
