## 1. Regression tests that bite the v1.39.8 helper

- [x] 1.1 Add a co-located test in `core/test/tugboat.test.ts` that extracts the train-phase stage-watch launch from `examples/supervisor/shell/tugboat.sh` (`ship_one` watch spawn) and the bundled `examples/supervisor/shell/ship-stage-watch.sh` `usage` / argv parser. Assert the bundled usage documents `--events-file` and does not accept `--milestone`. Assert Tugboat’s watch argv includes `--events-file` and does not include `--milestone`. Verify the test **fails** against current Tugboat (`--milestone "v$version"`)
- [x] 1.2 Keep `core/test/ship-stage-watch.test.ts` requiring one absolute events file and forbidding host-global latest-run discovery. Verify those existing tests still pass without changing the bundled script’s `--events-file` contract
- [x] 1.3 Add a train-side unit check that advance-wave `onRunReady` writes a stderr JSON line with `kind: loop_run_handoff` and an absolute `events` path, and that `train --json` stdout is still one `train_status` object. Verify the check **fails** against the current ready log that omits `events`

## 2. Train stderr handoff

- [x] 2.1 In the train advance-wave `onRunReady` path, emit a flushed stderr JSON line using the existing `formatLoopRunHandoff` payload (`kind: loop_run_handoff`, absolute `events`). Do not write that object to `train --json` stdout. Keep the existing prose ready line if useful. Verify task 1.3 now passes
- [x] 2.2 Confirm nested loop/single handoff still does not appear on train `--json` stdout (living `integrated-train-mode`). Verify the existing train JSON completeness helper still parses one `train_status`

## 3. Tugboat watch argv and spawn failure

- [x] 3.1 In `examples/supervisor/shell/tugboat.sh` train phase, stop passing `--milestone` / `--since` to `SHIP_STAGE_WATCH_BIN`. Parse this train’s stderr capture for a JSON line with `kind: loop_run_handoff` and an absolute `events` field. Spawn the bundled watch with `--events-file` set to that path (plus documented optional `--label` / `--pid-file`). Start the waiter before or as train starts so the first handoff is not missed. Verify task 1.1 now passes
- [x] 3.2 After spawning watch, observe immediate argv-parse exit. On non-zero exit, log `stage-watch argv rejected` (or equivalent) and do not log `stage-watch started pid=…` for that spawn. Do not treat a dead pid-file as a live watch. Do not fail the ship on watch spawn failure. Verify a fixture that execs the bundled script with `--milestone` records the named failure and continues train
- [x] 3.3 Keep default `SHIP_STAGE_WATCH_BIN` as `$SCRIPT_DIR/ship-stage-watch.sh`. Do not prefer `~/.local/bin/ship-stage-watch` on PATH. Do not add `--milestone` to `ship-stage-watch.sh`. Verify Tugboat comments and any supervisor docs that still show `--milestone` watch argv are aligned to `--events-file`

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 4.2 Run `openspec validate tugboat-stage-watch-argv-match` and `npm run ci` from the repo root. Verify both are green. Do not kill or restart an in-flight ship. Do not add `--skip-frg` as the default ship path
