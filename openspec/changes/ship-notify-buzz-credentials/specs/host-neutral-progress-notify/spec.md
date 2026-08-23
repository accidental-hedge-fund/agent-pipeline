## ADDED Requirements

### Requirement: Ship progress adapters SHALL present Buzz credential vars into notify children

A channel adapter that reports `pipeline ship` progress through `ship-notify` SHALL present `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` into that helper and into the bundled stage-watch child when those values are set on the supervisor env file or the parent process. When a supervisor-env `BUZZ_CREDENTIALS_FILE` value begins with `~/`, the adapter SHALL expand that prefix to `$HOME/` without sourcing or evaluating the rest of the file, and SHALL present the expanded path rather than the literal `~/` prefix. The adapter SHALL NOT overwrite an operator-set value. The adapter SHALL NOT `source` the whole supervisor env file as the presentation mechanism. Exact-run `--events-file` identity, installed material-filter presentation, and observational notify SHALL remain in force. Silent no-op after a dedupe write, when Buzz is intended (`SHIP_NOTIFY=1` and `BUZZ_BIN` is executable) and credentials cannot be resolved, SHALL NOT be the product path.

#### Scenario: Adapter watch spawn presents parent credentials file

- **WHEN** a ship progress adapter spawns bundled `ship-stage-watch.sh --events-file` for a live ship run
- **AND** the parent process has `BUZZ_CREDENTIALS_FILE` set to a readable file
- **THEN** the spawn environment SHALL include `BUZZ_CREDENTIALS_FILE` set to that same path
- **AND** the adapter SHALL NOT overwrite that value

#### Scenario: Adapter fills unset Buzz vars from supervisor env without sourcing the whole file

- **WHEN** a ship progress adapter starts a ship progress watch
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a readable path
- **THEN** the adapter SHALL present that path to `ship-notify` and to the watch child
- **AND** it SHALL NOT `source` the whole supervisor env file

#### Scenario: Adapter expands a leading-home supervisor-env credentials path

- **WHEN** a ship progress adapter starts a ship progress watch
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a path that begins with `~/`
- **AND** `$HOME` plus the remainder of that path is a readable file
- **THEN** the adapter SHALL present the expanded `$HOME/` path to `ship-notify` and to the watch child
- **AND** it SHALL NOT present the literal `~/` prefix
- **AND** it SHALL NOT `source` the whole supervisor env file

#### Scenario: Intended Buzz with missing credentials is not a silent adapter no-op

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is executable
- **AND** credentials cannot be resolved
- **THEN** the notify path SHALL leave a durable `audit.log` fail or `unconfigured` row
- **AND** ship and train SHALL still continue
- **AND** a missing host supervisor-env assignment SHALL NOT be accepted as a successful empty-channel delivery
