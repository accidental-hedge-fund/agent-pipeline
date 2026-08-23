## ADDED Requirements

### Requirement: Tugboat SHALL present Buzz credential vars into notify and stage-watch

Tugboat SHALL present `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` into `ship-notify` and into the bundled stage-watch child when those values are set on the parent process or on the supervisor env file (`$XDG_CONFIG_HOME/pipeline-supervisor/env` or `$HOME/.config/pipeline-supervisor/env`). When a supervisor-env `BUZZ_CREDENTIALS_FILE` value begins with `~/`, Tugboat SHALL expand that prefix to `$HOME/` without sourcing or evaluating the rest of the file, and SHALL present the expanded path rather than the literal `~/` prefix. Tugboat SHALL NOT overwrite a non-empty operator-set or parent value. Tugboat SHALL NOT `source` the whole supervisor env file. Watch spawn SHALL pass those Buzz vars on the spawn `env` line the same way it already passes `PIPELINE_MATERIAL_FILTER`. Existing `--events-file` argv, live-handoff binding, sibling default `SHIP_STAGE_WATCH_BIN`, and material-filter presentation SHALL remain in force.

#### Scenario: Watch spawn env includes parent credentials file

- **WHEN** Tugboat starts stage-watch for a train with `--events-file`
- **AND** the parent process has `BUZZ_CREDENTIALS_FILE` set to a readable file
- **THEN** the watch spawn environment SHALL include `BUZZ_CREDENTIALS_FILE` set to that same path
- **AND** Tugboat SHALL NOT overwrite that value

#### Scenario: Unset parent fills Buzz vars from the supervisor env file

- **WHEN** Tugboat starts a ship
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a readable path
- **THEN** Tugboat SHALL present that path to `ship-notify` and to the stage-watch child
- **AND** it SHALL NOT `source` the whole supervisor env file
- **AND** it SHALL NOT change `REPO_DIR` from that file

#### Scenario: Unset parent expands a leading-home supervisor-env credentials path

- **WHEN** Tugboat starts a ship
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a path that begins with `~/`
- **AND** `$HOME` plus the remainder of that path is a readable file
- **THEN** Tugboat SHALL present the expanded `$HOME/` path to `ship-notify` and to the stage-watch child
- **AND** it SHALL NOT present the literal `~/` prefix
- **AND** it SHALL NOT `source` the whole supervisor env file

#### Scenario: Operator-set Buzz vars are preserved

- **WHEN** the operator has already set `BUZZ_CREDENTIALS_FILE` to a non-empty path
- **AND** the supervisor env file sets a different path
- **AND** Tugboat starts stage-watch or invokes `ship-notify`
- **THEN** Tugboat SHALL pass the operator-set value through
- **AND** it SHALL NOT overwrite it with the supervisor env file value

### Requirement: Tugboat SHALL log when intended Buzz credentials cannot be resolved

If `SHIP_NOTIFY` is `1` and `BUZZ_BIN` is executable and `BUZZ_CREDENTIALS_FILE` cannot be resolved to a readable file, Tugboat SHALL log a named line (`buzz credentials missing` or equivalent). Tugboat SHALL continue the train phase. Notify failure SHALL NOT fail the ship. Tugboat SHALL NOT log that line solely because `BUZZ_BIN` is empty or not executable.

#### Scenario: Missing credentials is a named log and does not fail train

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is executable
- **AND** `BUZZ_CREDENTIALS_FILE` is empty or is not a readable file
- **AND** Tugboat would invoke `ship-notify` or spawn stage-watch
- **THEN** Tugboat SHALL log `buzz credentials missing` (or equivalent)
- **AND** it SHALL still run `pipeline train`
- **AND** it SHALL NOT treat that condition as a ship-phase failure

#### Scenario: Empty messenger binary does not log credentials missing

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is empty or is not executable
- **THEN** Tugboat SHALL NOT log `buzz credentials missing`
- **AND** it SHALL still run `pipeline train`

### Requirement: Tugboat Buzz-var watch spawn env SHALL be regression-tested

Automated checks SHALL fail if Tugboat’s train-phase stage-watch spawn environment omits `BUZZ_CREDENTIALS_FILE` when the parent process has that var set to a readable file. Those checks SHALL pass when the parent value is preserved on the spawn `env` line. Automated checks SHALL fail if a supervisor-env `BUZZ_CREDENTIALS_FILE=~/...` value is presented literally instead of as the expanded `$HOME/` path. Tests SHALL inspect Tugboat spawn env (and MAY extract helpers). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails if watch spawn omits parent credentials file

- **WHEN** the automated checks run against a Tugboat train watch spawn
- **AND** the parent has `BUZZ_CREDENTIALS_FILE` set to a readable file
- **AND** the spawn environment omits `BUZZ_CREDENTIALS_FILE`
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when spawn env preserves the parent credentials file

- **WHEN** the automated checks run against a Tugboat train watch spawn
- **AND** the parent has `BUZZ_CREDENTIALS_FILE` set to a readable file
- **AND** the spawn environment includes that same path
- **THEN** the checks SHALL pass

#### Scenario: Regression fails if a leading-home supervisor-env credentials path is passed literally

- **WHEN** the automated checks run against a Tugboat train watch spawn
- **AND** the parent has `BUZZ_CREDENTIALS_FILE` unset
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a `~/...` path whose `$HOME/` expansion is a readable file
- **AND** the spawn environment has the literal `~/` path or omits the expanded `$HOME/` path
- **THEN** the checks SHALL fail
