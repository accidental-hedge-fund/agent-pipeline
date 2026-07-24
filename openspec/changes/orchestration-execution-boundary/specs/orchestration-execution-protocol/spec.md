## ADDED Requirements

### Requirement: Versioned control-to-execution envelopes

The pipeline SHALL define five versioned envelopes for the control↔execution boundary —
`WorkAssignment` and `CancellationDirective` (control→worker), `ProgressEvent` and `ArtifactManifest`
(worker→control, streaming), and `WorkResult` (worker→control, terminal). Each envelope SHALL carry an
explicit `protocolVersion` and `schemaVersion`, and the control plane SHALL consume results from typed
fields and content digests only, never by scraping terminal prose.

#### Scenario: Assignment carries a stable protocol version

- **WHEN** the control plane issues a `WorkAssignment`
- **THEN** the assignment SHALL include an explicit `protocolVersion` and `schemaVersion`
- **AND** a worker SHALL be able to reject an assignment whose `protocolVersion` it cannot honor

#### Scenario: Result is consumed structurally, not by prose

- **WHEN** the control plane accepts a `WorkResult`
- **THEN** it SHALL derive outcome, attempted SHA, and artifact references from typed fields and digests
- **AND** it SHALL NOT parse free-form terminal output to determine the result

### Requirement: Stable identity and authorization scope on every envelope

Every boundary envelope SHALL carry stable `tenant`, `installation`, `run`, `stage`, and `attempt`
identity plus the `assignmentId`, and a `WorkAssignment` SHALL additionally carry the required
capabilities, the repository/environment authorization scope, and input & evidence digests. The
control plane SHALL reject any inbound envelope whose identity does not match a known, active
assignment.

#### Scenario: Envelope identity binds to a known assignment

- **WHEN** a worker submits a `ProgressEvent` or `WorkResult`
- **THEN** the control plane SHALL match it to an active assignment by `assignmentId` and attempt identity
- **AND** an envelope referencing no known active assignment SHALL be refused with a machine-readable diagnostic

#### Scenario: Assignment declares required capabilities and scope

- **WHEN** the control plane builds a `WorkAssignment`
- **THEN** it SHALL include the required capabilities and the repository/environment authorization scope
- **AND** it SHALL include input and evidence digests for the assigned work

### Requirement: At-least-once delivery made safe by idempotency, leases, and fencing

The protocol SHALL treat delivery and execution as at-least-once. Each assignment SHALL carry an
idempotency key of `(assignmentId, attempt)`, a lease with a deadline, and a monotonically increasing
fencing token issued with the lease. The control plane SHALL accept a state-advancing result only from
the current lease holder bearing the current fencing token, and SHALL refuse any duplicate, stale, or
superseded result for advancement while still retaining it as evidence. Assignment ownership, accepted
idempotency keys, cancellation state, and the fencing token SHALL be recorded in one durable assignment-
state authority via an atomic compare-and-commit operation that also records the lifecycle transition
each result gates; a restarted or failed-over control-plane process SHALL rehydrate "current" solely
from that authority before accepting or advancing any result.

#### Scenario: Duplicate delivery does not double-advance

- **WHEN** the same `(assignmentId, attempt)` result is delivered more than once
- **THEN** the control plane SHALL advance the run at most once for that idempotency key
- **AND** the redundant deliveries SHALL be recorded as evidence without re-advancing state

#### Scenario: Stale fencing token is refused for advancement

- **WHEN** a worker submits a `WorkResult` whose fencing token is not the current one for its assignment
- **THEN** the control plane SHALL refuse to advance run/stage state on that result
- **AND** it SHALL emit a machine-readable diagnostic identifying the stale token

#### Scenario: Concurrent claims resolve to one holder

- **WHEN** two workers attempt to claim the same assignment concurrently
- **THEN** at most one SHALL hold the active lease and its fencing token
- **AND** the other's subsequent state-advancing result SHALL be refused

#### Scenario: Control-plane restart or failover rehydrates from durable authority

- **WHEN** a control-plane process restarts or a controller fails over to a new instance
- **THEN** the new process SHALL rehydrate assignment ownership, fencing token, and cancellation state solely from the durable assignment-state authority
- **AND** it SHALL NOT accept or advance a result based on any in-memory record of "current" that predates the restart or failover

### Requirement: Versioned control-to-worker cancellation directive

The protocol SHALL define a `CancellationDirective` envelope (control→worker) as the sole mechanism by
which the control plane tells a worker that an already-dispatched assignment is cancelled. The
directive SHALL be bound to the assignment's `assignmentId`, attempt identity, and fencing token. The
control plane SHALL retry delivery of an unacknowledged directive until the worker acknowledges it (via
a direct acknowledgement or by reflecting the directive in its next `ProgressEvent`/`WorkResult`) or the
assignment's lease expires, and SHALL mark the assignment's fencing token superseded at the moment it
issues the directive so a racing in-flight `WorkResult` cannot advance run state.

#### Scenario: Worker learns of cancellation after dispatch

- **WHEN** the control plane cancels an assignment that has already been dispatched to a worker
- **THEN** it SHALL deliver a `CancellationDirective` bound to that assignment's `assignmentId`, attempt, and fencing token
- **AND** it SHALL retry delivery until the worker acknowledges the directive or the lease expires

#### Scenario: Cancellation directive supersedes a racing terminal result

- **WHEN** the control plane issues a `CancellationDirective` for an assignment
- **THEN** it SHALL mark that assignment's fencing token superseded at the same time
- **AND** any `WorkResult` submitted under the prior fencing token SHALL NOT advance run/stage state

### Requirement: Capability negotiation and compatibility rules

The protocol SHALL define backward/forward compatibility rules and capability negotiation. A worker
advertising a compatible newer minor version SHALL negotiate down to a mutually supported feature set,
and an incompatible major-version mismatch SHALL be rejected deterministically before any assignment
is executed. Capability negotiation outcomes SHALL be recorded as part of the assignment's evidence.

#### Scenario: Newer-minor worker negotiates down

- **WHEN** a worker advertises a newer minor protocol version than the control plane
- **THEN** the two SHALL negotiate to a mutually supported feature set
- **AND** the assignment SHALL proceed under the negotiated version

#### Scenario: Incompatible major version is rejected

- **WHEN** a worker advertises a protocol major version the control plane does not support
- **THEN** the control plane SHALL refuse to assign work to that worker
- **AND** the rejection SHALL be deterministic and carry a machine-readable diagnostic

### Requirement: Outbound-only, data-minimized trust boundary

The protocol SHALL support outbound-initiated authenticated worker connections and SHALL NOT require
any inbound listener into a customer network for control-plane operation. By default the control plane
SHALL exclude raw source, reusable secrets, unrestricted environment values, and sensitive logs from
its transport, admitting such transfer only through an explicit policy gate. Credentials SHALL be
short-lived and narrowly scoped, resolved worker-local where possible rather than relayed through the
control plane.

#### Scenario: No inbound listener required

- **WHEN** a worker executes an assignment across a network boundary
- **THEN** all control↔worker communication SHALL be reachable via worker-initiated outbound connections
- **AND** no inbound customer-network listener SHALL be required for any control-plane operation

#### Scenario: Sensitive material excluded by default

- **WHEN** a worker produces a `WorkResult` and `ArtifactManifest`
- **THEN** raw source, reusable secrets, unrestricted environment values, and sensitive logs SHALL be excluded from control-plane transport by default
- **AND** any transfer of such material SHALL require an explicit policy gate

### Requirement: Deterministic, observable boundary failure handling

The protocol SHALL resolve every boundary failure mode — disconnect/reconnect, lease expiry, worker
loss, cancellation race, late result, protocol skew, and partial artifact upload — to exactly one
deterministic outcome (park, retry under a new attempt, or reject) and SHALL emit a machine-readable
diagnostic code for it. A
cancellation SHALL be honored such that a cancelled assignment cannot later advance run state.

#### Scenario: Lease expiry re-assigns under a new attempt

- **WHEN** an assignment's lease expires before a terminal result arrives
- **THEN** the control plane SHALL be permitted to re-assign the work under a new attempt with a new fencing token
- **AND** a late result from the expired lease SHALL NOT advance run state

#### Scenario: Cancellation race cannot advance a cancelled run

- **WHEN** an assignment is cancelled while a worker result is in flight
- **THEN** the in-flight result SHALL NOT advance run/stage state
- **AND** the outcome SHALL be recorded with a machine-readable cancellation diagnostic

#### Scenario: Partial artifact upload is detected

- **WHEN** an `ArtifactManifest` references artifacts whose digests do not match the transferred bytes
- **THEN** the control plane SHALL treat the result as incomplete and refuse to accept it as terminal
- **AND** it SHALL emit a machine-readable partial-transfer diagnostic

### Requirement: Auditable evidence lineage across the boundary

Every accepted result SHALL bind a single auditable lineage chain — assignment, input digest, resolved
worker identity and capabilities, attempted commit SHA, result, and artifact digests — reconstructable
from durable artifacts alone, reusing the existing run-artifact/event evidence contracts rather than a
second evidence system.

#### Scenario: Accepted result is fully reconstructable

- **WHEN** the control plane accepts a `WorkResult`
- **THEN** the durable evidence SHALL let a reader reconstruct assignment → input digest → worker identity/capabilities → attempted SHA → result → artifact digests
- **AND** no link in that chain SHALL be provable only from an in-memory or narrative source
