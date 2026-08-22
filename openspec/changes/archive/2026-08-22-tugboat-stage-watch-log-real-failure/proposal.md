## Why

Ship v1.39.10 spawned bundled `ship-stage-watch.sh` with valid `--events-file`
argv from live `loop_run_handoff`. The watch died because `material-filter.mjs`
was not on PATH. Tugboat still logged `stage-watch argv rejected` after a 0.2s
pid check. Operators and later diagnoses chased #1184 again. Any post-spawn
death (missing filter, missing `SHIP_NOTIFY_BIN`, EPERM, not executable) is
mislabeled the same way. Sibling #1212 owns presenting the installed filter.
This change owns the playbook log contract only.

## What Changes

- **Class law, not a 1.39.10 mole.** After spawning `ship-stage-watch`, if
  the pid is not live, Tugboat SHALL log a named failure taken from the
  watch stderr tail and/or exit status. The log line SHALL carry the
  watch’s fail reason. It SHALL NOT log `stage-watch argv rejected` unless
  the watch usage/parser actually rejected argv (exit 2 plus usage text).
- **Pre-spawn non-absolute path is a distinct refusal.** Tugboat SHALL
  still refuse a non-absolute events path before spawn. That line SHALL be
  distinct (`events path is not absolute` or equivalent). It SHALL NOT
  reuse `stage-watch argv rejected` for that refusal.
- **Tests bite.** A unit test SHALL fail if a fixture watch exits 1 with
  stderr `material filter not found on PATH: material-filter.mjs` and the
  playbook contains `stage-watch argv rejected` without the filter line. A
  second test SHALL fail if Tugboat is given a relative events path and
  does not log the distinct non-absolute refusal.

**BREAKING** for any Tugboat fixture that expects every immediate watch
death to log `stage-watch argv rejected`, including a relative events
path before spawn.

Non-goals: presenting `PIPELINE_MATERIAL_FILTER` (#1212); in-engine
check-wait (#1205); deleting Tugboat; Buzz/Hermes SKILL swap; restoring
`--milestone`; failing the ship because watch notify is down.

## Acceptance criteria

- [ ] After Tugboat spawns `ship-stage-watch`, if the pid is not live, the
      playbook line names the watch fail reason from stderr tail and/or
      exit status (for example `material filter not found on PATH`).
- [ ] That death does not log `stage-watch argv rejected` unless the
      watch usage/parser actually rejected argv (exit 2 plus usage text).
- [ ] Tugboat refuses a non-absolute events path before spawn. The
      playbook line is distinct (`events path is not absolute` or
      equivalent). It does not spawn the watch for that path.
- [ ] A unit test fails if a fixture watch exits 1 with stderr
      `material filter not found on PATH: material-filter.mjs` and the
      playbook contains `stage-watch argv rejected` without the filter
      line.
- [ ] A second unit test fails if Tugboat is given a relative events
      path and does not log the distinct non-absolute refusal.
- [ ] Existing `--events-file` argv, live-handoff, sibling
      `SHIP_STAGE_WATCH_BIN`, and #1212 filter-present / missing-filter
      pre-spawn contracts stay in force. Watch spawn failure still does
      not fail the ship.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This tightens existing Tugboat stage-watch named-failure log
     law. -->

### Modified Capabilities

- `tugboat-thin-ship`: After a stage-watch spawn, a dead pid SHALL log a
  named failure that carries the watch stderr tail and/or exit status.
  Tugboat SHALL NOT log `stage-watch argv rejected` unless the watch
  usage/parser actually rejected argv (exit 2 plus usage text). A
  non-absolute events path SHALL be refused before spawn with a distinct
  message (`events path is not absolute` or equivalent). Regression tests
  SHALL fail if a filter-not-found death is labeled argv-rejected without
  the filter line, or if a relative events path does not log the distinct
  refusal.

Living `supervisor-ship-notify` stays observational. No playbook argv
delta. Sibling #1212 owns presenting the installed material-filter.

## Impact

- **Tugboat:** `examples/supervisor/shell/tugboat.sh`
  `observe_stage_watch_pid` (hardcoded `stage-watch argv rejected` on any
  dead pid) and `start_train_stage_watch` (same token for a relative
  events path before spawn).
- **Bundled watch:** `examples/supervisor/shell/ship-stage-watch.sh` keeps
  `--events-file` argv and current exit texts. Do not restore
  `--milestone`.
- **Tests:** `core/test/tugboat.test.ts` fixtures a dead watch with
  filter-not-found stderr, and a relative events path. Keep existing
  #1184 argv-reject (`--milestone` / `unknown argument`) and #1212
  missing-filter pre-spawn tests.
- **Depends on:** living `tugboat-thin-ship` `--events-file` argv (#1184)
  and installed material-filter presentation (#1212). This issue does
  not re-implement #1212.
- **Does not:** fail the ship solely because watch notify is down; glob
  latest runs; merge inside advance/loop; kill an in-flight ship.
- **Evidence:** `ship-v1.39.10/playbook.log` at `2026-08-21T21:38:51Z`:
  `stage-watch argv rejected`. `ship-v1.39.10/stage-watch.log`:
  `material filter not found on PATH: material-filter.mjs`. Argv was
  already `--events-file`. #1184 closed on v1.39.9.
}
