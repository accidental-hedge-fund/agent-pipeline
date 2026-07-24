# execution-worker-management Specification

## Purpose
TBD - created by archiving change orchestration-execution-boundary. Update Purpose after archive.
## Requirements
### Requirement: Worker registration with mutual, installation-scoped authentication

The management plane SHALL register, authenticate, and inventory execution workers using mutual,
installation-scoped authentication. Worker credentials SHALL be rotatable and revocable without
changing repository configuration, and a revoked credential's subsequent assignment claim SHALL be
refused.

#### Scenario: Registered worker authenticates mutually

- **WHEN** a worker registers with the management plane
- **THEN** authentication SHALL be mutual and scoped to a specific installation
- **AND** the worker SHALL appear in the fleet inventory with its declared identity

#### Scenario: Credential rotation needs no repository change

- **WHEN** a worker's credential is rotated
- **THEN** the worker SHALL continue to authenticate under the new credential
- **AND** no repository configuration SHALL need to change for rotation to take effect

#### Scenario: Revoked credential is refused

- **WHEN** a worker's credential is revoked
- **THEN** a subsequent assignment claim bearing that credential SHALL be refused
- **AND** the refusal SHALL carry a machine-readable revocation diagnostic

### Requirement: Revocation invalidates active leases and is checked on every inbound envelope

Credential revocation SHALL be a durable, linearizable management-state transition that, in the same
transaction, invalidates all of the worker's active leases and supersedes their fencing tokens — not
only a refusal applied to future assignment claims. The control plane SHALL validate revocation state
for every inbound envelope (`ProgressEvent`, `ArtifactManifest`, `WorkResult`) from an already-connected
worker, including one whose session predates the revocation, as part of the same acceptance/advancement
transaction used for the current lease and fencing-token check. Work orphaned by a revocation-triggered
lease invalidation SHALL be cancelled or safely re-assigned under a new attempt.

#### Scenario: Revocation supersedes an active lease and fencing token

- **WHEN** a worker's credential is revoked while it holds an active lease
- **THEN** the revocation SHALL invalidate that lease and supersede its fencing token in the same transaction
- **AND** the affected assignment SHALL be cancelled or re-assigned under a new attempt

#### Scenario: Pre-existing session is still checked for revocation

- **WHEN** a worker with an already-established outbound session submits a `WorkResult` after its credential was revoked
- **THEN** the control plane SHALL validate revocation state for that envelope in the same transaction as the lease/fencing-token check
- **AND** it SHALL refuse to advance run/stage state on that result

### Requirement: Capability and authorization gating before assignment

The management plane SHALL enforce a worker's declared capabilities and repository/environment
authorization scope before an assignment is dispatched. A worker lacking a required capability or the
authorization scope for the target repository/environment SHALL NOT be selected, and no assignment
SHALL be issued to it.

#### Scenario: Capability mismatch blocks selection

- **WHEN** an assignment requires a capability a candidate worker has not declared
- **THEN** the management plane SHALL exclude that worker from selection
- **AND** no assignment SHALL be dispatched to it

#### Scenario: Unauthorized repository access blocks selection

- **WHEN** a candidate worker lacks authorization scope for the assignment's target repository or environment
- **THEN** the management plane SHALL refuse to select it
- **AND** the run SHALL surface a machine-readable authorization diagnostic rather than dispatching work

### Requirement: Fleet lifecycle management — pools, drain, health, quotas

The management plane SHALL manage worker pools, capability and version declarations, policy
attachments, health, and quotas, and SHALL support draining a worker so that in-flight assignments
complete or re-assign while no new assignments are dispatched to it. Fleet lifecycle control SHALL be
distinct from read-only observability (#503): the management plane commands the fleet, whereas #503
only reports on it.

#### Scenario: Draining a worker stops new assignments

- **WHEN** a worker is placed into a draining state
- **THEN** the management plane SHALL dispatch no new assignments to it
- **AND** its in-flight assignments SHALL be allowed to complete or be re-assigned under a new attempt

#### Scenario: Sanitized health feeds observability without a command channel

- **WHEN** fleet health and delivery telemetry are shared with the observability layer
- **THEN** the shared data SHALL be sanitized read-only telemetry
- **AND** the observability layer SHALL NOT be able to issue execution commands through it

