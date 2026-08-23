## 1. Regression tests that bite the v1.40.0 silent no-op

- [x] 1.1 Add a co-located test in `core/test/ship-notify.test.ts` that invokes `examples/supervisor/shell/ship-notify.sh` with `SHIP_NOTIFY=1`, an executable fake `BUZZ_BIN`, `BUZZ_CHANNEL` set, and no readable `BUZZ_CREDENTIALS_FILE`. Assert `audit.log` contains a `fail` or `unconfigured` row and a named reason. Assert the helper still exits 0 and does not invoke send. Verify the test **fails** against current `ship-notify.sh` (silent `exit 0` after the dedupe write, empty `audit.log`)
- [x] 1.2 Keep the existing empty-`BUZZ_BIN` / `SHIP_NOTIFY=0` / empty-message fixture: exit 0, no send, no invented audit row, no `failed/` marker. Verify those cases still pass without changing the CI silent path
- [x] 1.3 Add a co-located test in `core/test/tugboat.test.ts` that extracts or execs `start_train_stage_watch` with parent `BUZZ_CREDENTIALS_FILE` set to a readable file. Assert the watch spawn environment includes that same path. Verify the test **fails** against current Tugboat (`env` does not pass `BUZZ_CREDENTIALS_FILE`)
- [x] 1.4 Add a Tugboat fixture that sets `SHIP_NOTIFY=1`, executable `BUZZ_BIN`, and no readable `BUZZ_CREDENTIALS_FILE`, then invokes notify or watch spawn. Assert the log contains `buzz credentials missing` (or equivalent) and that train is not failed. Verify the test **fails** against current Tugboat (no named credentials line)

## 2. ship-notify intended-Buzz audit

- [x] 2.1 In `examples/supervisor/shell/ship-notify.sh`, when `SHIP_NOTIFY=1` and `BUZZ_BIN` is executable and `BUZZ_CHANNEL` is empty or `BUZZ_CREDENTIALS_FILE` is empty or not a readable file, append `audit.log` with status `fail` or `unconfigured` and a named reason. Still exit 0. Do not invoke send. Do not silent-`exit 0` after a dedupe write with no audit row. Verify task 1.1 now passes
- [x] 2.2 Leave empty or non-executable `BUZZ_BIN` as a silent no-op (no audit, no `failed/` marker). Verify task 1.2 still passes
- [x] 2.3 Align the helper header comment that currently says missing credentials is a silent no-op. Verify the comment names the intended-Buzz audit split

## 3. Tugboat Buzz-var presentation and named log

- [x] 3.1 In `examples/supervisor/shell/tugboat.sh`, fill unset `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` from the supervisor env file (`$XDG_CONFIG_HOME/pipeline-supervisor/env` or `$HOME/.config/pipeline-supervisor/env`). Do not `source` the whole file. Do not overwrite a non-empty parent/operator value. Do not change `REPO_DIR` from that file. Verify a fixture with parent unset and a fake env file presents the file’s credentials path
- [x] 3.2 Pass `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` on the `start_train_stage_watch` `env` line the same way `PIPELINE_MATERIAL_FILTER` is already passed. `notify()` inherits process env after the fill. Verify task 1.3 now passes
- [x] 3.3 When `SHIP_NOTIFY=1` and `BUZZ_BIN` is executable and credentials cannot be resolved, log `buzz credentials missing` (or equivalent). Do not fail train/ship. Do not log that line when `BUZZ_BIN` is empty. Verify task 1.4 now passes
- [x] 3.4 Align `examples/supervisor/hermes/env.example` (and any supervisor comment that still says ship-notify no-ops if Buzz vars are unset) to the intended-Buzz audit split. Verify the template still documents `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL`
- [x] 3.5 Expand a leading `~/` on supervisor-env `BUZZ_CREDENTIALS_FILE` to `$HOME/` without sourcing the file. Add a regression test whose env file uses `BUZZ_CREDENTIALS_FILE=~/.hermes/profiles/...`. Verify the spawn env has the expanded `$HOME/` path and not the literal `~/`

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 4.2 Run `openspec validate ship-notify-buzz-credentials` and `npm run ci` from the repo root. Verify both are green. Do not kill or restart an in-flight ship. Do not add `--skip-frg` as the default ship path. Do not source the whole supervisor env file in Tugboat
