## MODIFIED Requirements

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

## ADDED Requirements

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
