## ADDED Requirements

### Requirement: Run identity artifacts SHALL persist logical_operation_id next to run_id

`run.json` SHALL persist `logical_operation_id` as a written-once identity field at run-directory initialization. Finalized `summary.json` SHALL include the same `logical_operation_id`. Resume re-entry SHALL reuse the written value and SHALL NOT overwrite it. Absence of the field on historical artifacts SHALL be tolerated by readers as missing correlation, not as a crash.

#### Scenario: First init writes both identities

- **WHEN** a run directory is initialized for a new public admission
- **THEN** `run.json` SHALL contain `run_id` and `logical_operation_id`
- **AND** those fields SHALL be non-empty and distinct

#### Scenario: Resume does not rewrite logical_operation_id

- **WHEN** `initRunDir` is called on a directory whose `run.json` already contains `logical_operation_id` `L`
- **THEN** `run.json` SHALL still contain `L`
- **AND** no second logical identity SHALL be written

#### Scenario: Finalized summary copies the written identity

- **WHEN** `finalizeRun` writes `summary.json` for a run whose `run.json` contains `logical_operation_id` `L`
- **THEN** `summary.json` SHALL include `L`
