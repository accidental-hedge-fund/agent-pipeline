## ADDED Requirements

### Requirement: Tugboat SHALL re-bind train stage-watch to a new live handoff while train is running

Tugboat SHALL, while the train process is still live, re-bind optional stage-watch when this train’s stderr records a `loop_run_handoff` whose absolute `events` path differs from the path the current watch is bound to. Tugboat SHALL reap the prior watch pid if it is still live, then SHALL spawn bundled `ship-stage-watch.sh` with `--events-file` set to that new absolute path (plus documented optional `--label` / `--pid-file`). If the prior watch has already exited because of bound-stream identity-terminal, Tugboat SHALL spawn the new watch only when that distinct newer path exists. Tugboat SHALL NOT immediately respawn `--events-file` against the same dead path after identity-terminal exit. Tugboat SHALL NOT glob host-global run directories or select the newest `events.jsonl` by mtime. Initial attach to the first live handoff while train is running SHALL remain in force. Watch spawn or re-bind failure SHALL NOT fail the ship. Default `SHIP_STAGE_WATCH_BIN`, installed material-filter presentation, and Buzz-var presentation SHALL remain in force.

#### Scenario: Second distinct handoff re-binds watch while train is live

- **WHEN** Tugboat has attached stage-watch to the first live `loop_run_handoff` absolute `events` path
- **AND** the train process is still live
- **AND** this train’s stderr later contains a `loop_run_handoff` whose `events` path is a different absolute path
- **THEN** Tugboat SHALL spawn stage-watch with `--events-file` set to that new path
- **AND** it SHALL NOT keep the prior watch bound to the old path as the live observer

#### Scenario: Prior watch exit on supersede does not respawn the same file

- **WHEN** the attached watch has exited after `loop_run_superseded` (or `loop_run_complete` / `loop_run_stopped`) on its bound file
- **AND** train stderr has no distinct newer `loop_run_handoff` `events` path
- **AND** the train process is still live
- **THEN** Tugboat SHALL NOT spawn a new watch against the same path
- **AND** it SHALL still run `pipeline train`

#### Scenario: Re-bind uses the live handoff path not a latest-run glob

- **WHEN** Tugboat re-binds stage-watch after a distinct new handoff
- **THEN** the `--events-file` argument SHALL be that handoff’s absolute `events` path
- **AND** Tugboat SHALL NOT search `~/.local/state/agent-pipeline` (or equivalent) for the newest `events.jsonl`

#### Scenario: Watch re-bind failure does not fail train

- **WHEN** Tugboat would re-bind stage-watch to a new handoff
- **AND** that spawn fails
- **THEN** Tugboat SHALL continue the train phase
- **AND** it SHALL NOT treat that failure as a ship-phase failure

### Requirement: Tugboat SHALL reap leftover stage-watch from this ship pid-file on the next ship start

Tugboat SHALL, after it acquires the ship RUN_DIR lock for milestone `vX.Y.Z`, reap a leftover live pid recorded in that ship’s `stage-watch.pid` before it attaches a new train watch. Tugboat SHALL remove the pid-file after that reap when it named this leftover. Tugboat SHALL NOT host-glob or `pkill` every `ship-stage-watch` process. Watchers for other milestone RUN_DIRs SHALL remain untouched. Watch reap SHALL NOT fail the ship.

#### Scenario: Leftover pid-file watch is reaped at next ship start

- **WHEN** Tugboat starts a ship for milestone `vX.Y.Z` and acquires that ship’s RUN_DIR lock
- **AND** `$RUN_DIR/stage-watch.pid` names a live process from a prior composer
- **THEN** Tugboat SHALL terminate that process
- **AND** it SHALL NOT leave that leftover following a prior loop `events.jsonl`

#### Scenario: Other-milestone watches are not killed

- **WHEN** Tugboat starts a ship for milestone `vX.Y.Z`
- **AND** a stage-watch pid-file for a different milestone RUN_DIR names a live process
- **THEN** Tugboat SHALL NOT terminate that other-milestone process as part of this ship start

### Requirement: Tugboat stage-watch re-bind and leftover reap SHALL be regression-tested

Automated checks SHALL fail if Tugboat attach helpers see a second distinct live `loop_run_handoff` `events` path while the fake train pid is live and never spawn `--events-file` against that new path. A second check SHALL fail if ship-start reap leaves a leftover live pid named by this ship’s `stage-watch.pid`. Tests SHALL inspect Tugboat helpers (and MAY extract `attach_train_stage_watch` / `start_train_stage_watch` / handoff extract). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails when a second handoff is ignored

- **WHEN** the automated checks run Tugboat attach helpers
- **AND** train stderr first hands off absolute path A, then distinct absolute path B, while the fake train pid is live
- **AND** no spawn uses `--events-file` set to B
- **THEN** the checks SHALL fail

#### Scenario: Regression fails when a leftover pid-file watch stays live

- **WHEN** the automated checks start Tugboat ship-start reap with this ship’s `stage-watch.pid` naming a live leftover process
- **AND** that process is still live after reap
- **THEN** the checks SHALL fail
