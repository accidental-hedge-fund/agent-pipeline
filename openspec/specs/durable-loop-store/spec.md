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
intact. A leftover temporary write file SHALL NOT become published authority. A truncated,
invalid, or partial published generation SHALL be detected and quarantined with evidence rather
than treated as the live document.

#### Scenario: An interrupted ledger write leaves the prior ledger readable

- **WHEN** a ledger write fails after the temporary file is created but before the rename
- **THEN** the run's ledger SHALL still parse and SHALL contain the pre-write content

#### Scenario: Logs are only ever appended

- **WHEN** an event or decision is recorded
- **THEN** the existing bytes of the corresponding log SHALL be unchanged
- **AND** exactly one new line SHALL be added

#### Scenario: Leftover temporary write is not the live ledger

- **WHEN** a crash leaves a temporary ledger write file beside the destination
- **THEN** a later reader SHALL use the previously published ledger when it still parses
- **AND** SHALL NOT treat the temporary file as live authority

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
transferring its token, so the recovering engine must acquire a fresh lock. After that fresh
acquisition, the new holder SHALL reconcile outstanding Recovery Episode claims whose
side-effect certainty is uncertain before any new mutation. The previous token SHALL NOT
authorize mutation.

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

#### Scenario: Takeover does not mutate before claim reconciliation

- **WHEN** lock recovery succeeds and a `started` Recovery Episode claim has uncertain certainty
- **THEN** the new holder SHALL NOT mutate under the new token until that claim is reconciled
  against the authoritative observer

---

### Requirement: The store SHALL maintain a dense, append-only event log

The store SHALL record each event with a monotonically increasing dense sequence number
starting at zero, a timestamp, a kind, and a data payload. Sequence assignment SHALL NOT
require re-reading the entire log. The store SHALL emit a terminal-stop event exactly once
for each stop instance, at the operation that causes that stop, and SHALL NOT re-emit that
same stop on later operations. After an operator resume supersedes a `run_fatal` stop, a
later distinct terminal stop SHALL append a new stop event. The original stop event SHALL
remain in the log.

#### Scenario: Sequence numbers are dense and ordered

- **WHEN** a run has recorded N events
- **THEN** their sequence numbers SHALL be exactly 0 through N-1 in write order

#### Scenario: A stop event is emitted once

- **WHEN** a run reaches a terminal stop condition
- **THEN** exactly one stop event SHALL appear in the log for that stop
- **AND** later operations that do not create a new stop SHALL NOT append another stop event

#### Scenario: A superseded run_fatal may record a later new stop event

- **WHEN** a `run_fatal` stop has been superseded by operator resume
- **AND** a later drive records a new terminal stop
- **THEN** the event log SHALL contain the original stop event and a new stop event
- **AND** the original stop event bytes SHALL be unchanged

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

### Requirement: The ledger item entry SHALL carry an optional current-stage projection

Each durable ledger item entry SHALL allow an optional current-stage projection used for loop-level observability. When present, that projection SHALL include at least a stage name string and MAY include a review/fix round, an updated-at timestamp, and the real advance run-store id associated with the current advance attempt. The projection SHALL be additive and optional so ledgers written before this capability remain readable. The projection SHALL NOT replace or encode the closed coarse item `state` set used for scheduling and recovery.

#### Scenario: Ledger with stage projection remains valid

- **WHEN** a ledger item entry includes `state: "in_progress"` and a current-stage projection with stage `implementing` and advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** the store SHALL accept and re-read that entry with both the coarse state and the stage projection intact

#### Scenario: Older ledger without stage projection still loads

- **WHEN** a ledger item entry written before this capability has only coarse `state` and no current-stage fields
- **THEN** the store SHALL load the ledger successfully
- **AND** status/audit consumers SHALL treat the stage projection as absent rather than failing schema validation

#### Scenario: Stage projection is not a substitute for coarse state

- **WHEN** an item has a current-stage projection of `implementing`
- **THEN** scheduling and recovery logic SHALL continue to consult the item's coarse `state` field
- **AND** the absence of a stage projection SHALL NOT by itself mark the item terminal or blocked

---

### Requirement: Status projection SHALL expose per-item current-stage when recorded

The store's read-only status projection SHALL include each item's current-stage projection when that projection is present on the ledger (stage name, round when present, advance run id when present). Producing status SHALL continue to perform no filesystem write, no lock acquisition, and no GitHub call.

#### Scenario: Status includes stage fields for an in-flight item

- **WHEN** status is requested for a run whose item `607` has a current-stage projection of `implementing` with a known advance run id
- **THEN** the status projection SHALL expose that stage and advance run id for item `607`

#### Scenario: Status still mutates nothing when stage fields are present

- **WHEN** status is produced for a run that includes current-stage projections
- **THEN** zero write, zero lock, and zero GitHub calls SHALL have been recorded through the injected seams

### Requirement: A ledger item that transitions to ready SHALL NOT keep a current blocked_theme

The durable loop store SHALL omit current `blocked_theme` from a ledger item when it records that item’s transition to coarse state `ready`. Prior history entries that recorded the block MAY remain. A recovery resume that transitions a blocked item to `in_progress` SHALL continue to retain `blocked_theme` so recovery identity still matches the class under resume. Consumers that consult `blocked_theme` as a live block SHALL do so only when `state === "blocked"`; a `ready` item SHALL NOT be treated as currently blocked because a leftover theme field is present.

#### Scenario: Ready transition clears current blocked_theme

- **WHEN** an item with `state: "in_progress"` and `blocked_theme: "implementation-ci"` transitions to `ready`
- **THEN** the written ledger entry for that item SHALL have `state: "ready"`
- **AND** it SHALL NOT expose a current `blocked_theme` of `implementation-ci`
- **AND** prior history that recorded the block SHALL remain readable

#### Scenario: Recovery resume to in_progress still retains blocked_theme

- **WHEN** a blocked item with `blocked_theme: "implementation-ci"` is recovered and resumes to `in_progress`
- **THEN** the written ledger entry SHALL keep `blocked_theme: "implementation-ci"`
- **AND** it SHALL NOT be required to clear theme solely because recovery succeeded

#### Scenario: Ready leftover theme is not treated as a live block

- **WHEN** a consumer reads a ledger item whose `state` is `ready` and a stale `blocked_theme` is present from a ledger written before this requirement
- **THEN** that consumer SHALL NOT treat the item as currently blocked solely because of that leftover theme

### Requirement: The store SHALL persist run_fatal supersede as a ledger clear plus an append-only event

The store SHALL write the ledger with `stop` absent, under the run lock token, using the
existing atomic ledger write, when operator `--resume` supersedes a `run_fatal` stop. It SHALL append
one event whose payload copies the prior stop record (`reason`, `time`, `theme`, `item_id` when
present, `outstanding_ready`). That event SHALL NOT rewrite or remove the original stop event. An
ineligible refusal SHALL NOT clear `ledger.stop` and SHALL NOT append a supersede event.

#### Scenario: Eligible supersede clears ledger.stop and preserves the prior stop in the log

- **WHEN** a re-drive-eligible `--resume` supersedes a `run_fatal` stop
- **THEN** the durable ledger SHALL have no `stop` field (or an equivalent absent stop)
- **AND** the event log SHALL include an append-only event carrying the prior stop `time` and
  `theme`
- **AND** the original terminal-stop event SHALL still parse from the log

#### Scenario: Ineligible refusal does not mutate the stop

- **WHEN** `--resume` refuses a `run_fatal` stop because no item is valid-outstanding
- **THEN** the ledger SHALL still carry the original `run_fatal` stop
- **AND** no supersede event SHALL be appended

### Requirement: Nested loop runs SHALL retain the parent logical_operation_id

When a durable loop run is spawned as nested child work of an admitted parent, the loop contract SHALL persist the parent's `logical_operation_id`. The store SHALL NOT mint a second logical identity for that nested run. Operator resume of the same loop-store run SHALL reuse the persisted id. The store SHALL remain the existing durable loop store; this requirement SHALL NOT introduce a second ledger, lock namespace, or scheduler.

#### Scenario: Nested loop contract stores the parent identity

- **WHEN** a parent train or ship admits a nested loop run with `logical_operation_id` `L`
- **THEN** the published loop contract SHALL record `L`
- **AND** the nested loop `run_id` MAY differ from the parent physical run id

#### Scenario: Loop resume keeps the persisted logical identity

- **WHEN** a later process resumes that loop-store run
- **THEN** the resumed loop SHALL use the persisted `logical_operation_id`
- **AND** SHALL NOT mint a new logical identity

### Requirement: The store SHALL quarantine truncated, invalid, or partial durable generations

The store SHALL detect a truncated, invalid, or partial generation of the contract, ledger,
Cooling record, Recovery Episode, or claim document. Detection SHALL include unreadable JSON,
schema failure, leftover temporary write files, and a rename that never published. A quarantined
generation SHALL NOT be treated as live authority. When a last valid generation exists, the store
SHALL reconstruct from that generation plus live truth when safe. When reconstruction is unsafe,
the Logical Operation SHALL remain owned as Cooling or an external-condition wait with evidence of
the quarantine. The store SHALL NOT invent a second database or generation log family.

#### Scenario: Invalid JSON ledger is quarantined

- **WHEN** the published ledger path exists but does not parse as the ledger schema
- **THEN** the store SHALL quarantine that generation with evidence
- **AND** SHALL NOT use it as the live Recovery Episode or stop authority

#### Scenario: Last valid generation is reconstructed when safe

- **WHEN** a quarantined generation is detected
- **AND** a last valid generation of the same document is still readable
- **THEN** the store SHALL reconstruct the live document from that last valid generation plus live
  truth when reconstruction is safe
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Unreconstructable generation stays owned as Cooling

- **WHEN** a quarantined generation is detected
- **AND** no last valid generation of the same document is readable
- **THEN** a holder with the current lock token SHALL persist Cooling or an external-condition wait with evidence of the quarantine
- **AND** the Logical Operation SHALL remain owned
- **AND** later mutation SHALL require live reconciliation

#### Scenario: Unauthenticated document read does not persist salvage Cooling

- **WHEN** a reader without the current lock token finds an unreconstructable generation
- **AND** no last valid generation of the same document is readable
- **THEN** the store SHALL quarantine that generation with evidence
- **AND** SHALL NOT overwrite the published document or last-valid generation
- **AND** SHALL return typed quarantine state that requires the current lock token to persist Cooling
