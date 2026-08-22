## Why

Ship v1.39.10 passed `--events-file` from live `loop_run_handoff` (v1.39.9
#1184). Buzz still got no stage posts. Tugboat spawned bundled
`ship-stage-watch.sh` with an absolute events path. The watch exited at once
with `material filter not found on PATH: material-filter.mjs`. Spawn PATH was
`dirname` of the sibling watch (`examples/supervisor/shell/`). That directory
does not contain `material-filter.mjs`. `PIPELINE_MATERIAL_FILTER` was unset
in live `~/.config/pipeline-supervisor/env`. `tugboat.sh` never mentions that
name. Host env is a fallback, not the owner of this spawn. The filter is an
install artifact (`hosts/_shared/material-filter.mjs` copied by `install.mjs`
to `<skillDir>/scripts/material-filter.mjs`). `engine-promote --host all` does
not write supervisor env. The next Buzz Ship stays silent until Tugboat
presents the installed filter.

## What Changes

- **Class law, not a 1.39.10 mole.** A composer that spawns bundled
  `ship-stage-watch.sh --events-file` SHALL present an executable installed
  `material-filter.mjs` in that spawn environment (`PIPELINE_MATERIAL_FILTER`
  or equivalent PATH). Default SHALL prefer the pin/host install path (the
  same tree `engine-promote` / `install.mjs` writes). Default SHALL NOT be
  the missing PATH name `material-filter.mjs`.
- **Host env is fallback, not owner.** Live supervisor env remaining unset
  SHALL NOT be required for the watch to exec the filter. If the operator
  already set `PIPELINE_MATERIAL_FILTER`, Tugboat SHALL NOT overwrite it.
- **Named missing-filter failure.** If no executable filter can be resolved,
  Tugboat SHALL log a named failure (`material filter missing` or equivalent)
  and SHALL NOT claim a live watch pid. Ship/train SHALL still continue
  (watch remains best-effort).
- **Tests bite.** A unit test SHALL fail if Tugboat’s watch spawn env has
  neither `PIPELINE_MATERIAL_FILTER` pointing at an executable nor
  `material-filter.mjs` on the spawn PATH. A second test SHALL fail if the
  bundled watch is spawned with only `--events-file` and no filter and the
  composer still logs `stage-watch started`. Those tests SHALL NOT require
  live host env to be set.

**BREAKING** for any Tugboat fixture that treats `stage-watch started pid=…`
as proof the watch is live when spawn env cannot exec the filter.

Non-goals: check-wait in `pipeline ship` (#1205); restoring `--milestone` as
the product watch argv (#1184); deleting Tugboat; MessagingPort / ship-auth;
hand-editing pin JSON / KEY wrap; killing the live 1.39.10 ship; writing
supervisor env from `engine-promote`; sibling #1213 (mislabeled
`argv rejected` when the watch dies for any reason).

## Acceptance criteria

- [ ] When Tugboat spawns bundled `ship-stage-watch.sh --events-file`, the
      spawn environment presents an executable installed
      `material-filter.mjs`. That is `PIPELINE_MATERIAL_FILTER` set to that
      path, or `material-filter.mjs` on the spawn PATH as an executable.
- [ ] The default resolved path is the pin/host skill install tree that
      `install.mjs` / `engine-promote` writes
      (`<skillDir>/scripts/material-filter.mjs`). The default is not the
      bare PATH name `material-filter.mjs` and is not
      `examples/supervisor/shell/`.
- [ ] Live `~/.config/pipeline-supervisor/env` remaining unset does not
      prevent that spawn from presenting the filter. Tests pass with host
      env unset.
- [ ] If the operator already set `PIPELINE_MATERIAL_FILTER` to a non-empty
      value, Tugboat does not overwrite it.
- [ ] If no executable filter can be resolved, Tugboat logs
      `material filter missing` (or equivalent). It does not log
      `stage-watch started pid=…` for that spawn. It does not claim a live
      watch pid. Train and ship continue.
- [ ] A unit test fails if Tugboat’s watch spawn env has neither
      `PIPELINE_MATERIAL_FILTER` pointing at an executable nor
      `material-filter.mjs` on the spawn PATH.
- [ ] A second unit test fails if the bundled watch is spawned with only
      `--events-file` and no filter and the composer still logs
      `stage-watch started`.
- [ ] Existing `--events-file` argv, live-handoff, and no-latest-run
      contracts stay in force. Default `SHIP_STAGE_WATCH_BIN` stays the
      sibling.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
      `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends existing Tugboat stage-watch compose law and ship
     material-filter observation law. -->

### Modified Capabilities

- `tugboat-thin-ship`: Tugboat SHALL export `PIPELINE_MATERIAL_FILTER` (or
  equivalent PATH) to an executable installed `material-filter.mjs` when it
  spawns `ship-stage-watch.sh --events-file`. Default SHALL prefer the
  pin/host install path. Tugboat SHALL NOT overwrite an operator-set
  `PIPELINE_MATERIAL_FILTER`. Missing executable filter SHALL be a named
  failure (`material filter missing` or equivalent) and SHALL NOT claim a
  live watch pid. Ship/train SHALL continue. Regression tests SHALL fail if
  spawn env cannot exec the filter or if that spawn still logs
  `stage-watch started`.
- `host-neutral-progress-notify`: A ship progress adapter that applies the
  shared material filter SHALL receive an executable installed
  `material-filter.mjs` from the pin/host install tree in spawn env. Host
  supervisor env remaining unset SHALL NOT be required. `engine-promote`
  SHALL NOT be required to write supervisor env for this spawn to work.

Living `supervisor-ship-notify` stays observational. No playbook argv
delta. Sibling #1213 owns mislabeled `argv rejected` death lines.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh`
  `start_train_stage_watch` / `observe_stage_watch_pid`. Present the
  installed filter on watch spawn. Log `material filter missing` when none
  is executable. Do not claim a live pid in that case.
- **Bundled watch:** `examples/supervisor/shell/ship-stage-watch.sh` keeps
  `PIPELINE_MATERIAL_FILTER` / `command -v material-filter.mjs`. Do not
  restore `--milestone`. Do not search latest runs.
- **Install:** no change to `install.mjs` copy of
  `hosts/_shared/material-filter.mjs` into `<skillDir>/scripts/`. Tugboat
  consumes that path. `engine-promote --host all` still does not write
  supervisor env.
- **Tests:** `core/test/tugboat.test.ts` extracts watch spawn env and
  fixtures the bundled watch with `--events-file` and no filter.
- **Docs / env.example:** Hermes `env.example` may keep
  `PIPELINE_MATERIAL_FILTER` as an operator override. Live host env is not
  the owner.
- **Depends on:** living `tugboat-thin-ship` `--events-file` argv (#1184)
  and `host-neutral-progress-notify` shared material filter.
- **Does not:** fail the ship solely because watch notify is down; restore
  `--milestone`; glob latest runs; merge inside advance/loop; kill an
  in-flight ship; require human edit of supervisor env after promote.
- **Evidence:** `~/.local/state/pipeline-supervisor/ship-v1.39.10/stage-watch.log`
  `material filter not found on PATH: material-filter.mjs`. Playbook
  `[2026-08-21T21:38:51Z] stage-watch argv rejected` (watch died in 0.2s).
  `train.stderr` had valid `kind: loop_run_handoff` `events`. `notify/audit.log`
  had no v1.39.10 `stage-adv-*` `delivered` lines until a human restarted
  `~/.local/bin/ship-stage-watch --milestone`.
}
