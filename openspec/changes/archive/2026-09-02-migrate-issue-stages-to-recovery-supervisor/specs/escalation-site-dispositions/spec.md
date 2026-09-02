## ADDED Requirements

### Requirement: Issue-stage escalation sites SHALL record a migrated RecoverySupervisor outcome

Every production issue-stage escalation site in the disposition inventory SHALL declare a migrated outcome in addition to its closed safety disposition. The migrated outcome SHALL name the observation class and the RecoverySupervisor treatment (re-entry, Cooling, external-condition wait, typed request, compatibility park projection, or authenticated cancellation). A mechanical site SHALL NOT migrate to a genuine human-authority request. Adding an issue-stage emitter without a migrated-outcome row SHALL fail the existing disposition drift guard.

#### Scenario: Inventory row includes migrated outcome

- **WHEN** the escalation-site inventory is loaded for issue-advancement stages
- **THEN** every issue-stage row SHALL include a migrated-outcome field
- **AND** that field SHALL be one of re-entry, Cooling, external-condition wait, typed request, compatibility park projection, or authenticated cancellation

#### Scenario: Missing migrated outcome fails the guard

- **WHEN** a production issue-stage `setBlocked` call site exists without a migrated-outcome row
- **THEN** the disposition drift-guard test SHALL fail
- **AND** the failure SHALL identify the file or site key

#### Scenario: Worktree-capacity site is not human authority

- **WHEN** an issue-stage site previously blocked as `worktree-capacity`
- **THEN** its migrated outcome SHALL be Cooling or an external-condition wait
- **AND** SHALL NOT be a typed Authority Request
