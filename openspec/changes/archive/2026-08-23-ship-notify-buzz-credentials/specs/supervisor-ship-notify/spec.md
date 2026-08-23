## MODIFIED Requirements

### Requirement: Ship-notify final failure SHALL leave a supervisor-visible marker

When a configured send fails after all retries, the helper SHALL write a durable marker file under the notify state directory that an operator or outer supervisor can discover without reading process memory. The marker SHALL include enough of the intended message content (or its key) and the failure reason to identify what was not delivered. The helper SHALL NOT require a second messenger product or a new pipeline stage to create this marker.

#### Scenario: Marker is present after total send failure

- **WHEN** a configured send fails all attempts
- **THEN** a file under the notify state directory SHALL identify the failed notification and reason
- **AND** the helper process SHALL still exit 0

#### Scenario: No-op configuration does not invent failure markers

- **WHEN** `SHIP_NOTIFY` is `0`, or the messenger binary is empty or not executable
- **THEN** the helper SHALL exit 0 without posting
- **AND** it SHALL NOT create a final-failure marker solely because the messenger binary is unset
- **AND** it SHALL NOT invent an audit row solely because the messenger binary is unset

### Requirement: Ship-notify delivery observability SHALL be regression-tested

Automated tests covered by `npm run ci` SHALL exercise the shared helper with a fake messenger binary (no real network). The suite SHALL include at least: (1) fail-then-succeed within budget → one successful outcome and success audit; (2) fail-all → failure audit, supervisor-visible marker, exit 0; (3) unwritable audit/marker targets after a fail-all send → exit 0 with a stderr persistence fallback; (4) unusable `PIPELINE_SUPERVISOR_STATE` with fail-all sends → exit 0 (and messenger attempts still run); (5) `SHIP_NOTIFY=1`, executable `BUZZ_BIN`, `BUZZ_CHANNEL` set, and no readable credentials file → `audit.log` contains a `fail` or `unconfigured` row. The suite SHALL fail if the helper again discards all send failures without durable audit/marker artifacts while claiming success only by exit code. The suite SHALL fail if the intended-Buzz missing-credentials path returns exit 0 with no fail/unconfigured audit row.

#### Scenario: Transient-success fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that fails twice then succeeds
- **THEN** the tests SHALL observe a successful audit outcome and the expected send attempt count
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Permanent-failure fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that always fails
- **THEN** the tests SHALL observe exit 0, a failure audit line, and a supervisor-visible marker
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Silent-mask regression fails the suite

- **WHEN** the helper implementation returns exit 0 after a total send failure without writing a failure audit or marker
- **THEN** the automated regression tests SHALL fail

#### Scenario: Unwritable-persistence fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that always fails and unwritable audit/marker targets
- **THEN** the tests SHALL observe exit 0 and a stderr persistence-failure signal
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Unusable-state-root fixture passes

- **WHEN** the automated ship-notify tests run with a fake messenger that always fails and an unusable `PIPELINE_SUPERVISOR_STATE`
- **THEN** the tests SHALL observe exit 0 and the expected send attempt count
- **AND** they SHALL pass under `npm run ci`

#### Scenario: Intended-Buzz missing-credentials regression fails the suite

- **WHEN** the helper is invoked with `SHIP_NOTIFY=1`, an executable `BUZZ_BIN`, `BUZZ_CHANNEL` set, and no readable `BUZZ_CREDENTIALS_FILE`
- **AND** `audit.log` has no `fail` or `unconfigured` row
- **THEN** the automated regression tests SHALL fail

## ADDED Requirements

### Requirement: Ship-notify SHALL audit when Buzz is intended and credentials cannot be resolved

When `SHIP_NOTIFY` is `1` and `BUZZ_BIN` is an executable file, and `BUZZ_CHANNEL` is empty or `BUZZ_CREDENTIALS_FILE` is empty or is not a readable file, the helper SHALL NOT silent-`exit 0` after writing a dedupe file. It SHALL append `audit.log` under the notify state directory with status `fail` or `unconfigured` and a named reason (for example `buzz credentials missing` or `buzz channel missing`). The helper SHALL still exit 0. The helper SHALL NOT invoke the messenger send command. Empty or non-executable `BUZZ_BIN` remains the silent no-op path and SHALL NOT require this audit row.

#### Scenario: Missing credentials file is audited when Buzz is intended

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is an executable file
- **AND** `BUZZ_CHANNEL` is set
- **AND** `BUZZ_CREDENTIALS_FILE` is empty or is not a readable file
- **THEN** the helper SHALL append an `audit.log` row with status `fail` or `unconfigured` and a named reason
- **AND** it SHALL exit 0
- **AND** it SHALL NOT invoke the messenger send command

#### Scenario: Missing channel is audited when Buzz is intended

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is an executable file
- **AND** `BUZZ_CHANNEL` is empty
- **THEN** the helper SHALL append an `audit.log` row with status `fail` or `unconfigured` and a named reason
- **AND** it SHALL exit 0
- **AND** it SHALL NOT invoke the messenger send command

#### Scenario: Empty messenger binary stays a silent no-op

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is empty or is not executable
- **THEN** the helper SHALL exit 0 without posting
- **AND** it SHALL NOT invent an audit row solely because the messenger binary is unset
- **AND** it SHALL NOT create a final-failure marker solely because the messenger binary is unset
