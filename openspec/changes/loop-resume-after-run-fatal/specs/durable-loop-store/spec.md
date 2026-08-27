## MODIFIED Requirements

### Requirement: The store SHALL maintain a dense, append-only event log

The store SHALL record each event with a monotonically increasing dense sequence number
starting at zero, a timestamp, a kind, and a data payload. Sequence assignment SHALL NOT
require re-reading the entire log. The store SHALL emit a terminal-stop event exactly once
for each stop instance, at the operation that causes that stop, and SHALL NOT re-emit that
same stop on later operations. After an operator resume supersedes a `run_fatal` stop, a
later distinct terminal stop SHALL append a new stop event. The original stop event SHALL
remain in the log.

#### Scenario: Sequence numbers are dense and ordered

- **WHEN** a run has recorded N events
- **THEN** their sequence numbers SHALL be exactly 0 through N-1 in write order

#### Scenario: A stop event is emitted once

- **WHEN** a run reaches a terminal stop condition
- **THEN** exactly one stop event SHALL appear in the log for that stop
- **AND** later operations that do not create a new stop SHALL NOT append another stop event

#### Scenario: A superseded run_fatal may record a later new stop event

- **WHEN** a `run_fatal` stop has been superseded by operator resume
- **AND** a later drive records a new terminal stop
- **THEN** the event log SHALL contain the original stop event and a new stop event
- **AND** the original stop event bytes SHALL be unchanged

## ADDED Requirements

### Requirement: The store SHALL persist run_fatal supersede as a ledger clear plus an append-only event

The store SHALL write the ledger with `stop` absent, under the run lock token, using the
existing atomic ledger write, when operator `--resume` supersedes a `run_fatal` stop. It SHALL append
one event whose payload copies the prior stop record (`reason`, `time`, `theme`, `item_id` when
present, `outstanding_ready`). That event SHALL NOT rewrite or remove the original stop event. An
ineligible refusal SHALL NOT clear `ledger.stop` and SHALL NOT append a supersede event.

#### Scenario: Eligible supersede clears ledger.stop and preserves the prior stop in the log

- **WHEN** a re-drive-eligible `--resume` supersedes a `run_fatal` stop
- **THEN** the durable ledger SHALL have no `stop` field (or an equivalent absent stop)
- **AND** the event log SHALL include an append-only event carrying the prior stop `time` and
  `theme`
- **AND** the original terminal-stop event SHALL still parse from the log

#### Scenario: Ineligible refusal does not mutate the stop

- **WHEN** `--resume` refuses a `run_fatal` stop because no item is valid-outstanding
- **THEN** the ledger SHALL still carry the original `run_fatal` stop
- **AND** no supersede event SHALL be appended
