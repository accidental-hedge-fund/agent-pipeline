## Why

Ship v1.39.7 first attempt resumed train as “milestone has no open issues”,
left `train.json` at 0 bytes, and did not write `train.complete.json`. Tugboat
then re-exec’d candidate `tugboat.sh` with `TUGBOAT_SKIP_TRAIN=1`. Skip-train
requires a non-empty `train.complete.json` or `train.json` (`-s`). It failed
with `FAIL: TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`.
Retry worked only after a human `git merge --ff-only origin/main` on the
control checkout so process-start Tugboat was the candidate (no re-exec).
That is not the product. After a later successful 1.39.7 ship, the EXIT trap
printed `lock_dir: unbound variable` under `set -u` even though phases were
already `ok`.

## What Changes

- **Class law, not a 1.39.7 mole.** Any Tugboat path that treats train as
  already complete (empty milestone / no open issues, or a prior complete
  artifact) SHALL write a non-empty `train.complete.json` before candidate
  composer re-exec. It SHALL NOT leave only a 0-byte `train.json`.
- **Skip-train accepts that artifact.** When `TUGBOAT_SKIP_TRAIN=1`, Tugboat
  SHALL accept a non-empty `train.complete.json` or a non-empty `train.json`
  and SHALL continue at FRG pack. It SHALL NOT fail
  `TUGBOAT_SKIP_TRAIN without a prior train artifact` on the empty-milestone
  resume path. Candidate skip-train SHALL also accept RUN_DIR evidence that
  train already resumed as no-open-issues (state or stderr), so a stale
  process-start composer can re-exec a fixed candidate without a human
  fast-forward.
- **Optional porcelain-clean control checkout fast-forward.** When
  `REPO_DIR` porcelain is empty, Tugboat MAY `git fetch` and fast-forward
  `REPO_DIR` to `origin/<base>` so process-start Tugboat matches the
  candidate. Tugboat SHALL NOT force-ff a dirty control checkout.
- **EXIT/RETURN lock release is `set -u` safe.** `release_lock` SHALL NOT
  print `lock_dir: unbound variable` after a successful ship. Bind
  `lock_dir` before the trap, or guard the trap when `lock_dir` is unset.
- **Tests bite the 1.39.7 helpers.** Extracted helpers SHALL fail the
  empty-milestone resume + re-exec + 0-byte `train.json` / missing
  `train.complete.json` skip-train case on the 1.39.7 body, and SHALL fail
  the EXIT trap unbound-variable probe. After the fix they SHALL write and
  accept a non-empty complete artifact and SHALL NOT print the unbound
  error.

Non-goals: a human `git merge --ff-only` as the product path; inventing
HMAC JSON / `--skip-frg` / `git tag`; the engine KEY_FILE loader (sibling
v1.39.8); pin-path identity (sibling v1.39.8); v1.40.0 packaging.

## Acceptance criteria

- [ ] When train treats “milestone has no open issues” as already complete,
      Tugboat writes a non-empty `train.complete.json` before candidate
      composer re-exec. It does not leave only a 0-byte `train.json`.
- [ ] When `TUGBOAT_SKIP_TRAIN=1` and `train.complete.json` (or a non-empty
      `train.json`) exists, Tugboat skips `pipeline train` and continues
      FRG / ensure-tag. It does not fail
      `TUGBOAT_SKIP_TRAIN without a prior train artifact`.
- [ ] When `TUGBOAT_SKIP_TRAIN=1` after a stale process-start no-open-issues
      resume that left 0-byte `train.json` and no `train.complete.json`,
      candidate Tugboat still continues if RUN_DIR state or `train.stderr`
      records that resume. A human fast-forward of `REPO_DIR` is not
      required.
- [ ] When `REPO_DIR` porcelain is empty, Tugboat MAY fetch and fast-forward
      to `origin/<base>`. When porcelain is dirty, Tugboat does not
      force-ff.
- [ ] A unit test fails on the 1.39.7 helper: no-open-issues resume +
      re-exec + empty `train.json` and missing `train.complete.json` →
      skip-train fail. After the fix the extracted helpers write and
      accept a non-empty complete artifact.
- [ ] EXIT/RETURN lock release does not print `lock_dir: unbound variable`
      after a successful ship under `set -u`. A test or script probe bites
      the 1.39.7 trap.
- [ ] OpenSpec delta on `tugboat-thin-ship` is valid. `npm run ci` is green.
      After any `core/` edit, `plugin/` is regenerated in the same change.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat train-resume and skip-train law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Empty-milestone / already-complete train resume
  SHALL write a non-empty `train.complete.json`. Skip-train SHALL accept
  that artifact (or a non-empty `train.json`, or RUN_DIR no-open-issues
  resume evidence) and SHALL NOT fail the empty-milestone re-exec path.
  Tugboat MAY porcelain-clean fast-forward `REPO_DIR` to `origin/<base>`
  and SHALL NOT force-ff a dirty checkout. EXIT/RETURN lock release SHALL
  NOT dereference unbound `lock_dir` under `set -u`. Regression tests
  SHALL fail on the 1.39.7 helpers.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh` train-resume branch
  (no-open-issues / prior complete), skip-train gate, optional porcelain
  fast-forward, and `ship_one` `release_lock` trap. Keep
  `frg-pack-helpers.sh` untouched unless a shared helper is extracted.
- **Tests:** `core/test/tugboat.test.ts`. Extract real helpers via
  `extractNamedFn` / `tugboatShipOneBody`. Inject fixtures. No live train,
  network, git, or subprocess ship.
- **Engine:** no `core/scripts/` change unless tests live under
  `core/test/tugboat.test.ts` (then `node scripts/build.mjs` in the same
  change).
- **Depends on:** living train-resume law (no-open-issues already complete),
  candidate composer re-exec + `TUGBOAT_SKIP_TRAIN=1` (#1164 / #1148).
- **Does not:** authorize a human control-checkout fast-forward; skip FRG;
  invent HMAC JSON; merge inside advance/loop; change KEY_FILE or pin-path
  identity.
- **Evidence:** `~/.local/state/pipeline-supervisor/ship-v1.39.7/playbook.log`
  at `2026-08-20T18:34:04Z`. `train.json` was 0 bytes;
  `train.complete.json` absent. Successful retry after control checkout ff
  to `fdb63be3`; later peel `e206cfda`. Post-success:
  `tugboat.sh: line 2210: lock_dir: unbound variable`.
