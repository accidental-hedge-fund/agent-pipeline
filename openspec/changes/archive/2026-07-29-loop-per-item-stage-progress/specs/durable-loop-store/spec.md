## ADDED Requirements

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
