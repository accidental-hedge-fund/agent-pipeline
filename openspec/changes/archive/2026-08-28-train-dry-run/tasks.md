## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected `runTrainCommand` / `runTrain` test that passes `--dry-run` with `--issues 10,11` and asserts the test **fails** against current code if the handler exits 2 with `pipeline train: --dry-run is not supported for train; omit it.` No live network, git, or subprocess.
- [x] 1.2 Add an injected `--merge --dry-run` fixture whose issue is `pipeline:ready-to-deploy` with an open PR, and assert the test **fails** against current code if `mergeIssuePr` or `advanceWave` is invoked. No live I/O.
- [x] 1.3 Add an injected `--json --dry-run` test that captures stdout and asserts the test **fails** against current code if stdout is not exactly one object with `kind: "train_plan"`, `schema_version: 1`, and `ordered_issues`. Assert it also fails if `kind` is `train_status`.
- [x] 1.4 Add an injected dry-run fixture that resolves a work list and asserts the test **fails** against current code if a train run directory / `events.jsonl` is created or if `train_run_handoff` is written.

## 2. Read-only planner

- [x] 2.1 In `runTrain` / `runTrainCommand`, accept `--dry-run` after selector admission. Build the plan from the existing snapshot + `orderIssuesForTrain` + merge-first prefix, plus GitHub PR/stage reads. Return before `initTrainRunStore`, `advanceWave`, `recoverParked`, and `mergeIssuePr`. Verify tasks 1.1, 1.2, and 1.4 now pass.
- [x] 2.2 Classify each item with the closed `intended_action` set (`would-advance`, `waiting-on-deps`, `would-merge`, `already-integrated`, `would-block`, `held`). Treat GitHub-merged ready-to-deploy as `already-integrated` without `fetchBase` / ancestry. Verify a merge-mode fixture matches the spec table and a non-merge fixture has no `would-merge`.
- [x] 2.3 Print human output that includes the existing `[train] ordered issues:` line, per-item stage/PR/frontier/action rows, and a footer that no mutations ran. Verify a unit test spies on `log` and finds those pieces. Do not default live train to dry-run: a test without `--dry-run` still calls `advanceWave`.

## 3. JSON contract and docs

- [x] 3.1 Emit exactly one unfenced `train_plan` object on stdout for `--json --dry-run` (`ordered_issues`, `merge_mode`, `items[].issue|stage|pr|intended_action`, `merge_first` when merge mode). Do not call the train event writer. Verify task 1.3 and that live `--json` without `--dry-run` is still one `train_status`.
- [x] 3.2 Keep `dryRun` in train `allowedFlags`. Update train documentation metadata usage to include `--dry-run`. Regenerated CLI reference / host SKILL tables MUST list it. Verify a unit test fails if the handler rejects allowlisted `--dry-run`, and that `docs:check` / generate-docs is clean after regen.

## 4. Gate

- [x] 4.1 After any `core/` or `hosts/claude` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [x] 4.2 Run `openspec validate train-dry-run` and `npm run ci` from the repo root. Verify both are green. Do not change live merge-first / frontier / recovery law. Do not merge from advance/loop. Do not make dry-run the default.
