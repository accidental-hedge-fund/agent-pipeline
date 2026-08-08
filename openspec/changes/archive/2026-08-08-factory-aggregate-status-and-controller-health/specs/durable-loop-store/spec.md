## ADDED Requirements

### Requirement: Factory-facing lock and liveness projection SHALL omit lock tokens and raw supervisor secrets

When the durable loop store's status projection or related process-identity records are consumed to build the allowlisted factory status read model, the public projection path used by factory status SHALL expose only allowlisted lock/liveness summary fields (for example holder host, staleness classification, and liveness class). It SHALL NOT place lock tokens, supervisor bearer tokens, or other secret-bearing fields into the factory status output. The internal store projection used by trusted same-host tooling MAY retain token fields for recovery logic, but those fields MUST NOT be the remote factory status contract.

#### Scenario: Factory status consumer never receives the lock token

- **WHEN** a run lock record contains a holder token
- **AND** factory status is assembled from store status/process readers
- **THEN** the factory status JSON SHALL NOT include that token value

#### Scenario: Allowlisted liveness summary remains available

- **WHEN** status is requested for a locked run with a same-host holder
- **THEN** factory status SHALL still be able to report an allowlisted lock/liveness summary
  (holder presence, host class, staleness/unknown/dead classification inputs)
- **AND** producing that summary SHALL perform no lock acquisition and no GitHub call

---

### Requirement: Optional operation and independent-heartbeat fields SHALL be legacy-safe

When process-identity or controller health evidence gains optional fields for independent heartbeat freshness, current operation identity, operation deadline, expected wait kind, or expected wait deadline, the store SHALL accept and re-read records that omit those fields. Consumers SHALL treat missing optional fields as unknown/legacy rather than failing schema validation for older runs.

#### Scenario: Older process record without operation deadline still loads

- **WHEN** a process-identity record written before operation-deadline fields exists
- **THEN** the store SHALL load it successfully
- **AND** factory status SHALL attribute operation/deadline as unknown or legacy

#### Scenario: Newer record with operation fields round-trips

- **WHEN** a process or controller health record includes current operation id and deadline
- **THEN** the store SHALL re-read those fields intact for status assembly
