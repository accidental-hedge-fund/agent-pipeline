## MODIFIED Requirements

### Requirement: Tugboat SHALL NOT claim a live stage-watch pid after argv reject

Tugboat SHALL log a named failure (`stage-watch argv rejected` or equivalent) only when the bundled stage-watch usage/parser actually rejected argv. That case is exit 2 plus usage text (including `unknown argument: --milestone`). Tugboat SHALL NOT log `stage-watch argv rejected` for any other immediate spawn failure. Tugboat SHALL NOT log `stage-watch started pid=…` for an argv-reject spawn. Tugboat SHALL NOT treat a pid-file left by a dead watch process as proof the watch is live. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: --milestone reject is a named failure not a started pid

- **WHEN** Tugboat would spawn stage-watch with `--milestone`
- **AND** the bundled script exits 2 with `unknown argument: --milestone`
- **THEN** Tugboat SHALL log `stage-watch argv rejected` (or equivalent)
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn
- **AND** it SHALL NOT claim a live watch pid
- **AND** it SHALL still run `pipeline train`

#### Scenario: Successful watch may log started only after argv parse succeeds

- **WHEN** Tugboat spawns the bundled watch with accepted argv
- **AND** that process remains live after argv parse
- **THEN** Tugboat MAY log a started pid
- **AND** that pid SHALL match a process that did not exit non-zero on argv parse

## ADDED Requirements

### Requirement: Tugboat SHALL log the spawned stage-watch fail reason when the pid is not live

Tugboat SHALL, after spawning `ship-stage-watch`, observe whether the pid is live. If the pid is not live, Tugboat SHALL log a named failure taken from the watch stderr tail and/or exit status. That log line SHALL carry the watch's fail reason (for example `material filter not found on PATH`). Tugboat SHALL NOT log `stage-watch argv rejected` for that death unless the watch usage/parser actually rejected argv (exit 2 plus usage text). Tugboat SHALL NOT log `stage-watch started pid=…` for that spawn. Tugboat SHALL NOT treat a pid-file left by a dead watch process as proof the watch is live. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: Filter-not-found death logs the filter line not argv rejected

- **WHEN** Tugboat has spawned stage-watch with accepted `--events-file` argv
- **AND** that process is not live
- **AND** the watch stderr contains `material filter not found on PATH: material-filter.mjs`
- **THEN** Tugboat SHALL log a named failure that includes `material filter not found on PATH`
- **AND** it SHALL NOT log `stage-watch argv rejected` for that spawn
- **AND** it SHALL NOT log `stage-watch started pid=` for that spawn
- **AND** it SHALL still run `pipeline train`

#### Scenario: Non-argv spawn death is not labeled argv rejected

- **WHEN** Tugboat has spawned stage-watch
- **AND** that process is not live
- **AND** the watch did not reject argv (no exit 2 plus usage text)
- **THEN** Tugboat SHALL log a named failure that includes the watch stderr tail and/or exit status
- **AND** it SHALL NOT log `stage-watch argv rejected` for that spawn
- **AND** it SHALL still run `pipeline train`

### Requirement: Tugboat SHALL refuse a non-absolute events path before stage-watch spawn

Tugboat SHALL refuse a non-absolute events path before spawning `ship-stage-watch`. That refusal SHALL log a distinct message (`events path is not absolute` or equivalent). Tugboat SHALL NOT spawn the watch for that path. Tugboat SHALL NOT log `stage-watch argv rejected` for that refusal. Tugboat SHALL continue the train phase. Watch spawn failure SHALL NOT fail the ship.

#### Scenario: Relative events path is a distinct pre-spawn refusal

- **WHEN** Tugboat would start stage-watch with a relative events path
- **THEN** Tugboat SHALL log `events path is not absolute` (or equivalent)
- **AND** it SHALL NOT spawn `ship-stage-watch` for that path
- **AND** it SHALL NOT log `stage-watch argv rejected` for that refusal
- **AND** it SHALL still run `pipeline train`

### Requirement: Tugboat stage-watch fail-reason log SHALL be regression-tested

Automated checks SHALL fail if a fixture watch exits 1 with stderr `material filter not found on PATH: material-filter.mjs` and the playbook contains `stage-watch argv rejected` without the filter line. A second check SHALL fail if Tugboat is given a relative events path and does not log the distinct non-absolute refusal (`events path is not absolute` or equivalent). Tests SHALL inspect Tugboat helpers (and MAY extract `observe_stage_watch_pid` / `start_train_stage_watch`). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on argv-rejected death without the filter line

- **WHEN** the automated checks spawn a fixture watch that exits 1 with stderr `material filter not found on PATH: material-filter.mjs`
- **AND** the playbook contains `stage-watch argv rejected` without that filter line
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if a relative events path does not log the distinct refusal

- **WHEN** the automated checks give Tugboat a relative events path
- **AND** Tugboat does not log `events path is not absolute` (or equivalent)
- **THEN** the checks SHALL fail
