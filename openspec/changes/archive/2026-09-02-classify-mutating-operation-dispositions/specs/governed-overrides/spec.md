## ADDED Requirements

### Requirement: Override auto-resume SHALL use the typed-request resume contract

After a governed override record is accepted, auto-resume of the advance loop SHALL use the typed-request resume contract. The override command SHALL NOT terminalize the Logical Operation through a command-local catch or raw `process.exit(1)` when the subsequent advance hits a mechanical fault. Governed authority checks, class policy, evidence, expiry, and kill-switch refusal SHALL remain in force before any mutation.

#### Scenario: Accepted override resumes through the contract

- **WHEN** an authorized actor records a valid override
- **THEN** the engine SHALL append the governed decision record
- **AND** auto-resume SHALL pass typed-request resume validation before re-entering advance

#### Scenario: Mechanical fault after override stays owned

- **WHEN** override recording succeeds
- **AND** the subsequent advance attempt fails mechanically
- **THEN** RecoverySupervisor SHALL retain ownership
- **AND** the override handler SHALL NOT exit through raw `process.exit(1)` as a lifecycle terminal
