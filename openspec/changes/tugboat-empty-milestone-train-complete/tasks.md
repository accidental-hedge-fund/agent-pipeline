## 1. Regression tests that bite the 1.39.7 helpers

- [ ] 1.1 Add a co-located test in `core/test/tugboat.test.ts` that extracts `ensure_train_complete_artifact` and `skip_train_has_proof` via `extractNamedFn` from `examples/supervisor/shell/tugboat.sh`. Fixture: 0-byte `train.json`, missing `train.complete.json`, `train.stderr` contains `has no open issues`. Assert the 1.39.7 skip-train gate fails (`TUGBOAT_SKIP_TRAIN without train.complete.json or train.json` or equivalent) and that `train.complete.json` is still absent or 0 bytes. Verify this test **fails** against current `ship_one` until the named helpers exist and write/accept the artifact
- [ ] 1.2 Add a sibling fixture where skip-train has only RUN_DIR evidence (0-byte `train.json`, no `train.complete.json`, `state.json` or `train.stderr` records no-open-issues resume). After the fix, assert skip-train succeeds and does not invoke `pipeline train`. Verify the assertion exists before the helper is fixed
- [ ] 1.3 Add a lock-release probe that extracts `release_lock`, unsets `lock_dir`, and fires EXIT under `set -u`. Assert the 1.39.7 body prints `lock_dir: unbound variable`. Verify the probe **fails** the current trap (line 2210) before the guard is added

## 2. Resume artifact and skip-train gate

- [ ] 2.1 Extract `ensure_train_complete_artifact` in `examples/supervisor/shell/tugboat.sh`. Call it from every `train_resumed=1` path (no-open-issues and prior-complete) before `maybe_reexec_candidate_composer`. Keep a non-empty `train.complete.json`; copy a non-empty success `train.json`; otherwise write a synthetic last `train_status` with `complete` true and no blocker. Never copy a 0-byte `train.json`. Verify task 1.1 now sees a non-empty complete file on the empty-milestone fixture
- [ ] 2.2 Extract `skip_train_has_proof` and use it for the `TUGBOAT_SKIP_TRAIN=1` gate. Accept `-s train.complete.json`, `-s train.json`, or RUN_DIR no-open-issues evidence (`train.stderr` `has no open issues` or `state.json` train `ok` with that resume detail). Fail closed only when none of those proofs exist. Verify tasks 1.1 and 1.2 pass on the fixed gate and still fail closed when RUN_DIR has no artifact and no no-open-issues evidence
- [ ] 2.3 Keep candidate re-exec (`maybe_reexec_candidate_composer`, `TUGBOAT_SKIP_TRAIN=1`, same-PID lock retain). Verify existing `#1164` re-exec and lock-retain tests still pass

## 3. Lock-release trap and optional porcelain-clean ff

- [ ] 3.1 Guard `release_lock` so unset `lock_dir` is a no-op under `set -u`. Bind `lock_dir="$RUN_DIR/lock"` before installing RETURN/EXIT traps. Keep both traps. Verify task 1.3 no longer prints `lock_dir: unbound variable` and that a bound `lock_dir` is still removed
- [ ] 3.2 Add optional `maybe_ff_repo_dir` at process start: when porcelain is empty, `git fetch` + `git merge --ff-only origin/<base>` using the same `<base>` as the factory-release request; if the running script path is under `REPO_DIR` and HEAD moved, `exec` that path. When porcelain is dirty, skip. A skipped or failed ff MUST NOT fail the ship. Do not `reset --hard`. Verify with a fixture or source assertion that dirty porcelain does not invoke `--ff-only`, and that the ship path does not treat ff failure as train/FRG fail

## 4. Gate

- [ ] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 4.2 Run `openspec validate tugboat-empty-milestone-train-complete` and `npm run ci` from the repo root. Verify both are green. Do not add `--skip-frg` as the default ship path. Do not treat a human `git merge --ff-only` as the product path
