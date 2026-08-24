## 1. Regression tests that bite the v1.40.0 hang

- [x] 1.1 Add a follow-mode test in `core/test/ship-stage-watch.test.ts` that spawns bundled `examples/supervisor/shell/ship-stage-watch.sh` (not `--once`) against a fixture events file and injectable `PIPELINE_MATERIAL_FILTER`. Append a `loop_run_superseded` JSONL line. Assert the watcher process exits within a short timeout and that stdout includes the identity-terminal material line. Verify the test **fails** against current `tail -F | material-filter --until-ship-terminal` (process still alive)
- [x] 1.2 Keep existing `ship-stage-watch` tests that require one absolute `--events-file` and forbid host-global latest-run discovery. Verify those tests still pass without adding `--milestone` / `--since` or a latest-run glob
- [x] 1.3 Add a Tugboat helper fixture in `core/test/tugboat.test.ts` that attaches watch to handoff path A, lets the fake watch exit, then writes a distinct `loop_run_handoff` path B on the same stderr while the fake train pid is live. Assert a spawn uses `--events-file` set to B. Verify the fixture **fails** against current one-shot `attach_train_stage_watch` (first-only extract, no re-bind)
- [x] 1.4 Add a Tugboat helper fixture that writes a live leftover pid into this ship’s `stage-watch.pid` and runs ship-start reap. Assert that leftover pid is not live afterward. Verify the fixture **fails** against current `ship_one` (no reap before attach)

## 2. Shared identity-terminal stop and watcher follow-exit

- [x] 2.1 Teach the shared material filter (or the watch-owned parser of the same kinds) to treat `loop_run_superseded`, `loop_run_complete`, and `loop_run_stopped` as identity-terminal for a loop stream, while `ship_phase` complete/completed remains terminal for a ship stream. Emit the terminal material line before stop. Verify filter unit coverage for those kinds, and that `--until-ship-terminal` is not the only stop used on a loop file
- [x] 2.2 Change `examples/supervisor/shell/ship-stage-watch.sh` follow mode so the watcher process exits after bound-stream identity-terminal. Reap the follow child (`tail -F` or equivalent) so `pipefail` cannot hang on a silent file. Do not glob latest runs or open a `superseded_by` path. Verify task 1.1 now passes
- [x] 2.3 Add a documented inactivity bound (default 30s, test-overridable env) that exits only after identity-terminal when no further parsed line arrives. Verify a live quiet file without identity-terminal does not exit solely on that bound. Verify an idle-after-supersede fixture exits even if the follow child would otherwise hang
- [x] 2.4 Before follow, classify the exact bound file for a pre-existing identity-terminal. If present, emit that material line and exit (do not hang on unbounded `tail -n 0 -F`). Do not replay historical non-terminal material and do not open `superseded_by`. Verify a fixture whose terminal line predates watcher startup now passes
- [x] 2.5 Use one cursor-aware reader so a terminal appended after scan EOF is still consumed from the same offset. Add a fixture that holds after scan EOF, appends `loop_run_superseded`, then continues follow. Verify the watcher exits and emits the identity-terminal line. Verify the fixture **fails** against a split scan plus `tail -n 0 -F` FIFO attach (process still alive, no terminal line)

## 3. Tugboat re-bind and leftover pid-file reap

- [x] 3.1 In `examples/supervisor/shell/tugboat.sh` train phase, while `train_pid` is live, detect a later `loop_run_handoff` whose absolute `events` path differs from the bound watch path. Reap the prior watch if live, then spawn `--events-file` on the new path. Do not respawn the same path after identity-terminal exit. Do not glob latest runs. Keep first-handoff attach so early stages are still observed. Watch failure still must not fail the ship. Verify task 1.3 now passes
- [x] 3.2 After acquiring the ship RUN_DIR lock, reap a leftover live pid named by `$RUN_DIR/stage-watch.pid` and remove that file when it named the leftover. Do not `pkill` every `ship-stage-watch` on the host. Do not touch other-milestone RUN_DIR pid-files. Verify task 1.4 now passes
- [x] 3.3 Align ship-milestone / supervisor watch notes so follow exits on loop identity-terminal and Tugboat re-binds from train stderr handoff. Do not document latest-run discovery. Verify comments in Tugboat still describe `--events-file` only

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 4.2 Run `openspec validate ship-stage-watch-supersede-reattach` and `npm run ci` from the repo root. Verify both are green. Do not kill or restart an in-flight v1.40.0 ship. Do not add `--skip-frg` as the default ship path
