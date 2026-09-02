## ADDED Requirements

### Requirement: Issue-stage handlers SHALL be RecoverySupervisor adapters

The orchestrator SHALL dispatch the current `STAGES` label to the matching issue-stage handler. Each delivery-stage handler from `planning` through `ready-to-deploy` SHALL run as a RecoverySupervisor operation adapter. A non-advancing process outcome (`blocked`, `waiting`, `no-op`, `finalized`, or `error`) MAY stop the current invocation. That process stop SHALL NOT end RecoverySupervisor ownership of the Logical Operation. Advance, single, and loop SHALL still never merge.

#### Scenario: Blocked projection does not end ownership

- **WHEN** a delivery-stage adapter returns a non-advancing `blocked` outcome
- **THEN** the advance loop MAY stop the current invocation
- **AND** RecoverySupervisor SHALL retain ownership
- **AND** the observation SHALL NOT mark the Logical Operation complete or cancelled

#### Scenario: Waiting projection does not end ownership

- **WHEN** a delivery-stage adapter returns `{ advanced: false, status: "waiting" }`
- **THEN** the loop MAY break for later re-entry
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or an external-condition wait

#### Scenario: Advance still never merges after adapter migration

- **WHEN** the advance loop dispatches any stage transition from `ready` through `ready-to-deploy`
- **THEN** it SHALL make no call to `pipeline merge`, `mergePr`, or a merge-queue plan/drive handler
- **AND** it SHALL NOT add a merge stage
