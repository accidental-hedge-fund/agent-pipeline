# durable-loop-store Specification

## Purpose
TBD - created by archiving change absorb-goal-loop-core. Update Purpose after archive.
## Requirements
### Requirement: The durable loop store SHALL be owned by Agent Pipeline and resolve a Pipeline state home

The durable loop store SHALL resolve its state home in a documented order — an explicit
Pipeline state-home environment override, then the XDG state directory, then a
home-relative default — and SHALL place each run under `<state-home>/runs/<run-id>`. A run
directory SHALL contain exactly one contract document, one ledger document, at most one
lock document, one append-only event log, and one append-only decision log. The store SHALL
NOT write into any state home owned by the external goal-loop skill.

#### Scenario: State home resolves from the documented precedence

- **WHEN** the Pipeline state-home override is set
- **THEN** the store SHALL use it verbatim
- **AND** when it is unset the store SHALL fall back to the XDG state directory, then to the
  home-relative default

#### Scenario: A new run creates the documented layout

- **WHEN** a run is initialized
- **THEN** the run directory SHALL contain the contract and ledger documents
- **AND** the contract SHALL record the Pipeline-native contract schema id and the ledger the
  Pipeline-native ledger schema id

#### Scenario: The store never writes to legacy state

- **WHEN** any store write path is exercised through the injected filesystem seam
- **THEN** no write SHALL target a legacy goal-loop state home

---

### Requirement: The store SHALL write run documents atomically and logs append-only

The store SHALL write the contract and ledger documents by writing a temporary file in the
same directory, flushing it, and renaming it into place, so a reader never observes a
partially written document. The event and decision logs SHALL be appended to and never
rewritten. A failure part-way through a write SHALL leave the previously durable document
intact.

#### Scenario: An interrupted ledger write leaves the prior ledger readable

- **WHEN** a ledger write fails after the temporary file is created but before the rename
- **THEN** the run's ledger SHALL still parse and SHALL contain the pre-write content

#### Scenario: Logs are only ever appended

- **WHEN** an event or decision is recorded
- **THEN** the existing bytes of the corresponding log SHALL be unchanged
- **AND** exactly one new line SHALL be added

---

### Requirement: The store SHALL enforce exactly one exclusive lock holder per run

The store SHALL acquire a run lock by exclusive creation, so that two concurrent acquisitions
result in exactly one holder. The lock record SHALL identify the holding engine, process id,
hostname, acquisition time, an opaque token, and the run id. Every mutating operation on the
run SHALL require the holder's token, and an absent or mismatched token SHALL be refused with
a lock-class failure that names the current holder. Release SHALL require the matching token.

#### Scenario: A second acquisition does not create a second holder

- **WHEN** two acquisitions race for the same run
- **THEN** exactly one SHALL succeed and return a token
- **AND** the other SHALL be refused with a lock-class failure naming the existing holder

#### Scenario: A mutating operation without the holder's token is refused

- **WHEN** a transition, decision, event, or reconciliation is attempted with an absent or
  mismatched token
- **THEN** it SHALL be refused with a lock-class failure
- **AND** the ledger and logs SHALL be unchanged

#### Scenario: Read-only operations do not require the lock

- **WHEN** status is requested for a run whose lock is held by another process
- **THEN** the status SHALL be returned without acquiring or requiring a token

---

### Requirement: The store SHALL recover a lock only when its holder is provably dead on the same host

The store SHALL classify a lock as stale only when it was recorded on the current host and
its process id is not alive. A lock recorded on a different hostname SHALL never be
classified as stale, because liveness cannot be verified. Recovery of a non-stale lock SHALL
be refused unless an explicit force is supplied, and every recovery SHALL record an event
naming the previous holder and the reason. Recovery SHALL remove the lock rather than
transferring its token, so the recovering engine must acquire a fresh lock.

#### Scenario: A dead same-host holder is recoverable

- **WHEN** the lock records this host and a process id that is not alive
- **THEN** the lock SHALL be reported stale and recovery SHALL succeed
- **AND** an event SHALL record the previous holder and the staleness reason

#### Scenario: A cross-host lock is never auto-recovered

- **WHEN** the lock records a different hostname
- **THEN** it SHALL be reported not stale regardless of elapsed time
- **AND** recovery without an explicit force SHALL be refused

#### Scenario: Recovery invalidates the old token

- **WHEN** a lock is recovered
- **THEN** the previous token SHALL no longer authorize any mutating operation
- **AND** a fresh acquisition SHALL be required to obtain a new token

---

### Requirement: The store SHALL maintain a dense, append-only event log

The store SHALL record each event with a monotonically increasing dense sequence number
starting at zero, a timestamp, a kind, and a data payload. Sequence assignment SHALL NOT
require re-reading the entire log. The store SHALL emit a terminal-stop event exactly once,
at the operation that causes the stop, and SHALL NOT re-emit it on subsequent operations.

#### Scenario: Sequence numbers are dense and ordered

- **WHEN** a run has recorded N events
- **THEN** their sequence numbers SHALL be exactly 0 through N-1 in write order

#### Scenario: A stop event is emitted once

- **WHEN** a run reaches a terminal stop condition
- **THEN** exactly one stop event SHALL appear in the log for that stop
- **AND** later operations on the run SHALL NOT append another stop event

---

### Requirement: The store SHALL expose a read-only status projection that performs no writes

The store SHALL provide a status projection reporting run id, engine, repository, canonical
hash, per-item states, active items, remaining recovery budget, consecutive-blocked count,
merge barrier, stop record, current lock holder with its staleness assessment, last
reconciliation, and event count. Producing this projection SHALL perform no filesystem write,
no lock acquisition, and no GitHub call.

#### Scenario: Status reports the full run picture

- **WHEN** status is requested for an existing run
- **THEN** it SHALL include the run id, per-item states, recovery budget, consecutive-blocked
  count, merge barrier, stop record, and lock holder with staleness

#### Scenario: Status mutates nothing

- **WHEN** status is produced through the injected seams
- **THEN** zero write, zero lock, and zero GitHub calls SHALL have been recorded

#### Scenario: Status of an unknown run fails rather than creating one

- **WHEN** status is requested for a run id with no run directory
- **THEN** it SHALL fail naming the run id and the location searched
- **AND** no run directory SHALL be created

