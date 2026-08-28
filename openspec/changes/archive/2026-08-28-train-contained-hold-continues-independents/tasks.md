## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected merge-mode `runTrain` fixture whose work list is independent issues `268, 267, 266`, where 268 returns a contained non-ready hold (blocked, waiting, or `ok: false` with no merge). Assert the test **fails** against current code if train exits before 267 and 266 are advanced, or if the log contains `will not implement another sibling`. No live network, git, or subprocess.
- [x] 1.2 Add an injected merge-mode fixture that starts with 1074 already `blocked` and 1073 independent `pipeline:ready`. Assert the test **fails** against current code if 1073 is never advanced or the blocker matches `will not implement #1073 while #1074 is blocked/parked`.
- [x] 1.3 Add an injected merge-mode fixture where 268 is held and 271 declares a transitive `Depends on` path to 268. Assert the test **fails** against current code if 271 is advanced or merged, and **fails** if 271 is omitted from `status.items` or lacks terminal `dependency-skipped`.
- [x] 1.4 Add an injected `--json` merge-mode fixture for `279, 269, 268, 267` where 279 and 269 integrate, 268 is held, 267 is independent and integrates. Assert the test **fails** against current code if `items` omits 267, if `complete` is true, or if exit code is 0.

## 2. Controller law

- [x] 2.1 In merge-mode `runTrain`, hold a contained per-item outcome (blocked, needs-human, waiting, non-ready, non-ok with no merge in flight) and continue the frontier. Remove the four `will not implement another sibling` returns and the `held.size > 0` implement STOP. Keep recover-parked-once, merge-first, and uncontained containment STOP. Verify tasks 1.1 and 1.2 now pass.
- [x] 2.2 Walk the declared depends-on graph so remaining items with a direct or transitive path to a held item are held as `dependency-skipped` and excluded from advance and merge. Do not skip a held item's prerequisite solely for the reverse edge. Verify task 1.3 and a unit test of the independence helper for A→B→C vs reverse edge.
- [x] 2.3 Keep the admission snapshot as the work list for the whole run. Do not re-list `--milestone` into `ordered` after start. Verify an injected fixture that grows the milestone list mid-run does not add the new issue to `ordered_issues` or `items`.

## 3. Result, events, and docs

- [x] 3.1 Add `dependency-skipped` to the train item terminal set. After remaining independents finish, merge eligible independent ready-to-deploy items, then exit non-zero with `complete: false` when any item remains held or skipped. Every selected issue SHALL appear in `items`. Verify task 1.4 and that live `--json` stdout is still one `train_status` object with `schema_version` 1.
- [x] 3.2 Emit `train_sibling_halted` for a merge-mode contained hold and `train_item_completed` with terminal `dependency-skipped` for skipped dependents. Verify an injected event-store fixture records halt of 268 and later work on 267, and does not treat the hold as `run_complete` for the whole train.
- [x] 3.3 Invert the `#1063` halt fixtures so they require independent continuation and independent merge after a contained park. Keep merge-first fixtures (already-R2D open PR merges before implement of a newer sibling) and containment-failure STOP fixtures. Update the train file-header comment so anti-PR-farm is merge-first, not sibling abandonment.

## 4. Gate

- [x] 4.1 After any `core/` or `hosts/claude` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [x] 4.2 Run `openspec validate train-contained-hold-continues-independents` and `npm run ci` from the repo root. Verify both are green. Do not reclassify `waiting` as a loop class. Do not change `ci_timeout`. Do not merge from advance/loop. Do not add `--continue-on-block`.
