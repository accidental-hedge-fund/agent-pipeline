# execution-worker-runtime Specification

## Purpose
TBD - created by archiving change orchestration-execution-boundary. Update Purpose after archive.
## Requirements
### Requirement: Worker executes only within the assigned scope

The execution-plane worker SHALL perform repository checkout/worktree operations, harness invocations,
file edits, commands, tests, builds, and artifact production strictly within the scope declared by its
`WorkAssignment`. The worker SHALL refuse any operation outside the assignment's repository/environment
authorization scope, independently of control-plane intent.

#### Scenario: In-scope work proceeds

- **WHEN** a worker receives a `WorkAssignment` naming a repository, worktree, and command scope
- **THEN** it SHALL perform checkout, harness, command, test, and build operations only within that scope
- **AND** it SHALL produce artifacts only for that assignment

#### Scenario: Out-of-scope operation is refused

- **WHEN** an assignment's declared scope does not authorize a repository or command a worker is asked to run
- **THEN** the worker SHALL refuse the operation
- **AND** it SHALL report a machine-readable scope-violation diagnostic in its result

### Requirement: Worker enforces local boundaries independently of control-plane intent

The execution-plane worker SHALL enforce its own filesystem, process, network, secret, repository, and
command boundaries independently of the control plane, keeping raw source, credentials, and sensitive
artifacts local or in customer-controlled storage unless an explicit policy permits transfer. A
permissive or malformed control-plane instruction SHALL NOT cause the worker to exceed its local
boundaries.

#### Scenario: Local boundary holds against a broad instruction

- **WHEN** a control-plane instruction would, if followed literally, read or transmit material outside the worker's configured boundaries
- **THEN** the worker SHALL enforce its local boundary and refuse the excess
- **AND** it SHALL keep raw source, credentials, and sensitive artifacts local absent an explicit transfer policy

### Requirement: Worker emits identity-bound progress, evidence, and terminal result

The execution-plane worker SHALL emit heartbeats, structured progress, bounded logs, an
`ArtifactManifest`, and a terminal `WorkResult`, each bound to the assignment identity and the
attempted commit SHA. Progress and logs SHALL be bounded so a worker cannot exhaust the control plane
with unbounded output.

#### Scenario: Terminal result binds to assignment and SHA

- **WHEN** a worker completes an assignment
- **THEN** its `WorkResult` SHALL reference the `assignmentId`, attempt identity, and attempted commit SHA
- **AND** its `ArtifactManifest` SHALL list artifact digests for that assignment

#### Scenario: Heartbeats signal liveness

- **WHEN** a worker is executing a long-running assignment
- **THEN** it SHALL emit periodic heartbeats bound to the assignment identity
- **AND** absence of heartbeats past the lease deadline SHALL let the control plane treat the worker as lost

### Requirement: Worker contains no pipeline-lifecycle or release-policy logic

The execution-plane worker SHALL NOT contain or duplicate pipeline lifecycle or release-policy
decision logic, and SHALL NOT advance run or stage lifecycle state. A `WorkResult` that asserts a
lifecycle transition SHALL be treated as advisory data only and ignored for advancement by the control
plane.

#### Scenario: Worker cannot advance lifecycle

- **WHEN** a worker submits a `WorkResult` that claims to advance the run to a later stage or to `ready-to-deploy`
- **THEN** the control plane SHALL ignore that claim for lifecycle advancement
- **AND** only the control plane's own policy evaluation SHALL determine any stage transition

