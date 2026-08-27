## ADDED Requirements

### Requirement: Operator resume SHALL be allowed to supersede a run_fatal stop so later transitions can proceed

The engine SHALL allow an operator `--resume` that has classified a `run_fatal` stop as
re-drive-eligible to clear that stop from the ledger under the run lock. After that clear, the run
SHALL NOT carry a terminal stop, and subsequent item transitions, reconciliation, and recovery
writes SHALL proceed under existing non-stopped rules. The engine SHALL NOT treat the cleared
`run_fatal` as still blocking those operations.

A run that still carries a terminal stop (including an ineligible `run_fatal` that was not
superseded, and every other stop reason) SHALL continue to refuse subsequent item transitions with
a stop-class failure naming the stop record.

The engine SHALL NOT clear `stop.reason` values other than `run_fatal` on `--resume` in this
capability.

#### Scenario: Eligible run_fatal resume unblocks transitions at the same run id

- **WHEN** operator `--resume` supersedes a `run_fatal` stop because at least one item is
  valid-outstanding
- **THEN** a later item transition on that run SHALL be accepted under the existing transition graph
- **AND** it SHALL NOT be refused with a stop-class failure that names the superseded stop

#### Scenario: Ineligible run_fatal resume keeps the stop-class refusal

- **WHEN** operator `--resume` refuses a `run_fatal` stop because no item is valid-outstanding
- **THEN** a subsequent item transition SHALL still be refused with a stop-class failure naming
  that `run_fatal` stop
- **AND** `ledger.stop` SHALL still be present

#### Scenario: Non-run_fatal stops stay refuse-all on resume

- **WHEN** `--resume` targets a run whose `stop.reason` is not `run_fatal`
- **THEN** the engine SHALL NOT clear that stop as part of this capability
- **AND** subsequent item transitions SHALL remain refused with a stop-class failure naming the
  stop record
