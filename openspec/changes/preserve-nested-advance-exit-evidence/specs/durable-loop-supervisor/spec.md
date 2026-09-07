## ADDED Requirements

### Requirement: Nested advance termination SHALL remain observable through durable recovery

When a spawned whole-item advance terminates with a nonzero exit code or signal and authoritative issue/run evidence does not establish a more specific terminal outcome, the dispatch response SHALL include a canonical recoverable diagnostic with structured process-exit evidence. The evidence SHALL identify the nested-child boundary, exit code or signal, and whether the child initialized its run store. A valid recoverable diagnostic on a failed dispatch response SHALL be preserved through supervisor classification and persisted recovery; the supervisor SHALL NOT replace it with a generic failed-outcome diagnostic.

#### Scenario: Nonzero child exit is preserved

- **WHEN** a nested whole-item child exits nonzero while its issue remains at the same nonterminal stage
- **THEN** the dispatch response SHALL carry a `workflow-engine-defect` diagnostic naming the exit code or signal
- **AND** the diagnostic SHALL include structured nested-child process-exit evidence

#### Scenario: Authoritative completion wins over process exit

- **WHEN** a nested child exits nonzero but fresh authoritative issue state proves `pipeline:ready-to-deploy`
- **THEN** the dispatch outcome SHALL remain `ready_to_deploy`
- **AND** the process exit SHALL NOT downgrade verified completion to failure

#### Scenario: Supervisor preserves the producer diagnostic

- **WHEN** `pipeline/loop-execution@1` reports `failed` with a valid recoverable diagnostic
- **THEN** the supervisor SHALL persist and pass that exact diagnostic to recovery
- **AND** it SHALL NOT replace the reason, evidence key, or structured detail with a generic normalized-failure diagnostic

#### Scenario: Authoritative observer failure does not erase process evidence

- **WHEN** a nested child terminates abnormally
- **AND** the subsequent authoritative issue observation fails
- **THEN** the dispatch response SHALL retain the structured child termination diagnostic
- **AND** the observer failure SHALL NOT collapse the response to an unexplained generic failure
