## ADDED Requirements

### Requirement: The supervisor SHALL update per-item current-stage from observed advance evidence during dispatch

While the supervisor is advancing an item through `pipeline/loop-execution@1` and a real advance run store is linked and confirmed, the supervisor SHALL observe that store's stage-relevant events (or an equivalent injected advance-progress seam) and update the item's durable current-stage projection on material stage or round changes. The supervisor SHALL append a structured stage-progress event on the loop run's event trail for each material update. The supervisor SHALL continue to hand off whole items only: it SHALL NOT write GitHub pipeline stage labels, SHALL NOT expose or call any per-stage verb, and SHALL NOT merge.

#### Scenario: Mid-advance stage observation updates the ledger projection

- **WHEN** the supervisor is waiting on a dispatched item whose linked advance run emits `stage_start` for `plan-review`
- **THEN** the item's durable current-stage projection SHALL update to `plan-review` (with round when the advance evidence supplies one)
- **AND** a structured stage-progress event for that item SHALL appear on the loop run event trail

#### Scenario: Supervisor still does not own stage labels

- **WHEN** the supervisor updates current-stage for an item from advance evidence
- **THEN** every GitHub `pipeline:*` label transition for that item SHALL still originate in the per-item advance
- **AND** the supervisor SHALL issue no stage-label write of its own

#### Scenario: Observation uses the injectable seam

- **WHEN** a unit test injects a fake advance-progress reader and a fake store
- **THEN** material fake stage events SHALL produce ledger projection updates and loop stage-progress events without a real child process or network call

---

### Requirement: Audit mode SHALL include the per-item stage table in its read-only report

`--audit` SHALL include a per-item stage-progress section (table or equivalent structured listing) drawn from durable artifacts: each item's id, current-stage presentation (or queued/pending when not mid-advance), and advance run-id when known. This section is in addition to process identity, action-evidence timeline, watchdog / no-progress state, and run position. Audit SHALL remain fully read-only.

#### Scenario: Audit report carries stage table fields

- **WHEN** `--audit` is invoked for an existing run with at least one item that has a recorded current-stage and advance run id
- **THEN** the audit report SHALL include that item's stage and advance run id in the stage-progress section
- **AND** through injected seams it SHALL record no ledger write, no lock acquisition, no process-identity write, and no GitHub mutation

#### Scenario: Audit of items without stage data still succeeds

- **WHEN** `--audit` is invoked for a run whose items lack current-stage projections
- **THEN** it SHALL still print the existing supervisor timeline and position
- **AND** the stage section SHALL present pending/unknown/queued items without failing the audit
