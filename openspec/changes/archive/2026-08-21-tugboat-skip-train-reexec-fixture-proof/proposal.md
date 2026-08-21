## Why

Ship v1.39.8 train succeeded and FRG HMAC passed. `pipeline release 1.39.8`
then failed `npm run ci`. Four existing Tugboat tests that spawn real
`tugboat.sh` and re-exec the candidate composer printed
`FAIL: TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`.
#1182’s extracted-helper tests passed. Sibling fixtures did not leave
skip-train proof the re-exec can see. Buzz `Ship milestone v1.39.8` did
not tag.

## What Changes

- **Class law, not a four-test mole.** Fixtures that spawn real
  `tugboat.sh` and re-exec candidate Tugboat with `TUGBOAT_SKIP_TRAIN=1`
  SHALL leave a skip-train proof in that ship `RUN_DIR` before the
  re-exec (`train.complete.json`, or a non-empty `train.json`, or
  documented empty-milestone stderr). `writeTugboatFrgFixture` and the
  #1151 candidate-engine tests SHALL do this.
- **Ship-CI env isolation.** Those fixtures SHALL NOT inherit parent
  `TUGBOAT_SKIP_TRAIN=1` / `TUGBOAT_CANDIDATE_COMPOSER` from a live
  Tugboat `pipeline release` process unless the test is itself asserting
  skip-train. They SHALL still run their own train (or fail closed for
  the original reason) and SHALL still assert original FRG / candidate
  behavior.
- **Re-exec sees the same `RUN_DIR`.** `maybe_reexec_candidate_composer`
  SHALL export `PIPELINE_SUPERVISOR_STATE` and `REPO_DIR` so the
  candidate process reads the same ship artifacts.
- **Regression bite.** The four v1.39.8 CI failures SHALL fail on
  current `main` (`000c1f6b`) without the fixture proof (including when
  parent skip-train env is present), and SHALL pass with proof plus
  isolation. They SHALL NOT be rewritten into skip-train-only checks.

Non-goals: re-implementing #1181–#1183; `--skip-frg` / `git tag` / hand
pin JSON; stage-watch argv (#1184 / v1.39.9); killing a live ship.

## Acceptance criteria

- [ ] `writeTugboatFrgFixture` and the #1151 candidate-engine tests that
      spawn real `tugboat.sh` and re-exec candidate Tugboat with
      `TUGBOAT_SKIP_TRAIN=1` leave a skip-train proof in that ship
      `RUN_DIR` before the re-exec (`train.complete.json`, or non-empty
      `train.json`, or documented empty-milestone stderr).
- [ ] Those fixtures do not inherit parent `TUGBOAT_SKIP_TRAIN=1` (or
      `TUGBOAT_CANDIDATE_COMPOSER`) from `process.env` unless the test
      is asserting skip-train. The first process can still train.
- [ ] These four tests still assert their original FRG / candidate
      behavior, not merely skip-train success:
      - `tugboat after train-complete records candidate argv not pin argv (#1151)`
      - `tugboat live in_progress at cap 1 keeps ticking prepare (#1150)`
      - `tugboat not-live in_progress at cap 1 fails closed (#1150)`
      - `tugboat fails closed when candidate engine is unavailable (#1151)`
- [ ] On current `main` (`000c1f6b`) those four tests fail without the
      fixture proof when parent skip-train env is present (the v1.39.8
      release CI case). With proof plus isolation they pass.
- [ ] `maybe_reexec_candidate_composer` exports `PIPELINE_SUPERVISOR_STATE`
      and `REPO_DIR` so the re-exec sees the same `RUN_DIR` artifacts.
- [ ] OpenSpec delta on `tugboat-thin-ship` names this fixture-proof
      law. `npm run ci` is green. After any `core/` edit, `plugin/` is
      regenerated in the same change.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat skip-train re-exec and fixture law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Spawn-real-`tugboat.sh` fixtures that re-exec
  the candidate composer with `TUGBOAT_SKIP_TRAIN=1` SHALL leave
  skip-train proof in that ship `RUN_DIR` before the re-exec and SHALL
  isolate inherited parent skip-train env. `maybe_reexec_candidate_composer`
  SHALL export `PIPELINE_SUPERVISOR_STATE` and `REPO_DIR`. The four
  #1150 / #1151 tests SHALL keep their original FRG / candidate
  assertions. Regression SHALL fail on `main` without that proof when
  parent skip-train env is present.

## Impact

- **Tests:** `core/test/tugboat.test.ts` — `writeTugboatFrgFixture` and
  the four named spawn-real-`tugboat.sh` tests. Shared spawn env for
  those fixtures. No live train, network, git, or subprocess ship
  beyond the existing fake-pipeline `tugboat.sh` spawn.
- **Tugboat:** `examples/supervisor/shell/tugboat.sh`
  `maybe_reexec_candidate_composer` export list only. Do not re-work
  `skip_train_has_proof` or `ensure_train_complete_artifact` (#1182).
- **Engine:** no `core/scripts/` change unless tests live under
  `core/test/` (then `node scripts/build.mjs` in the same change).
- **Depends on:** living skip-train proof law (#1182) and candidate
  composer re-exec (#1164).
- **Does not:** re-implement #1181–#1183; skip FRG; invent HMAC JSON;
  merge inside advance/loop; kill a live ship; change stage-watch argv.
- **Evidence:** `~/.local/state/pipeline-supervisor/ship-v1.39.8/state.json`
  phase `release-prepare` status `failed` at `2026-08-21T06:26:36Z`.
  `release-prepare.err` shows the four `✖` tests and
  `FAIL: TUGBOAT_SKIP_TRAIN without train.complete.json or train.json`.
  Train: `[train] complete (3 item(s), all integrated)`. FRG
  `frg-2026-08-21T06-25-24-386Z-2dfff2d5` passed.
