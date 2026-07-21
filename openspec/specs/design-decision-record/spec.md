# design-decision-record Specification

## Purpose
TBD - created by archiving change design-interrogation-gate. Update Purpose after archive.
## Requirements
### Requirement: A triggered gate SHALL produce a schema-versioned decision record

When the design gate fires, the implementer SHALL emit a machine-readable decision record carrying a
top-level `schema_version` (initially `1`) and a `decisions` array. Each decision SHALL carry: `id`
(stable within the run), `title`, `surface` (the affected files/modules or public interfaces),
`alternatives` (each with `option` and `rejected_because`), `assumptions`, `invariants`, `evidence`
(repository or runtime citations supporting the decision), `generalization_boundary` (where the
decision stops holding), and `uncertainty` (a stated level plus what would falsify the decision). The
record SHALL be validated before use; a record missing a required field, or carrying an empty
`alternatives` array, SHALL be rejected and re-requested rather than accepted.

#### Scenario: valid record accepted
- **WHEN** the implementer emits a record with `schema_version: 1` and one decision populating every required field
- **THEN** the record SHALL validate
- **AND** it SHALL be passed to the interrogation round as the reviewer's primary input

#### Scenario: record missing required fields is rejected
- **WHEN** the emitted record omits `generalization_boundary` on a decision
- **THEN** validation SHALL fail identifying the missing field
- **AND** the gate SHALL re-request the record rather than proceeding to interrogation

#### Scenario: decision with no alternatives is rejected
- **WHEN** a decision carries an empty `alternatives` array
- **THEN** validation SHALL fail
- **AND** the gate SHALL NOT treat the decision as interrogable evidence

#### Scenario: unknown schema_version
- **WHEN** a persisted record carries a `schema_version` the engine does not recognize
- **THEN** the engine SHALL refuse to consume it and SHALL request a fresh record rather than guessing its shape

---

### Requirement: The decision record SHALL be size-bounded with explicit truncation

The engine SHALL enforce `design_gate.limits`: at most `max_decisions` decisions, at most
`max_field_chars` characters per free-text field, and at most `max_artifact_bytes` for the persisted
artifact. Content exceeding a bound SHALL be truncated with an explicit truncation marker recording
what was dropped; content SHALL NOT be silently discarded, and the persisted artifact SHALL never
exceed `max_artifact_bytes`.

#### Scenario: over-long field is truncated with a marker
- **WHEN** a decision's `rejected_because` exceeds `max_field_chars`
- **THEN** the stored value SHALL be truncated to the limit and carry an explicit truncation marker
- **AND** the truncation SHALL be visible in the evidence bundle

#### Scenario: too many decisions
- **WHEN** the implementer emits more than `max_decisions` decisions
- **THEN** the persisted record SHALL retain at most `max_decisions` of them
- **AND** SHALL record the count of decisions dropped by the bound

#### Scenario: artifact byte ceiling honored
- **WHEN** the assembled record would exceed `max_artifact_bytes`
- **THEN** the persisted artifact SHALL be reduced to at most `max_artifact_bytes` with a truncation marker

---

### Requirement: The decision record SHALL exclude hidden model reasoning and SHALL be redacted

The record SHALL contain only externally checkable statements and citations. The prompt SHALL instruct
the implementer not to emit private chain-of-thought or raw hidden reasoning, and the engine SHALL
apply the same secret-redaction rules used for `CommandRecord` and `PromptRecord` before persisting the
record or embedding it in any comment.

#### Scenario: secrets redacted before persistence
- **WHEN** a decision's `evidence` includes a value matching the engine's secret patterns
- **THEN** the persisted record and any posted comment SHALL carry the redacted form
- **AND** the raw secret SHALL NOT appear in the run directory or the evidence bundle

#### Scenario: no raw hidden reasoning is stored
- **WHEN** the record is persisted
- **THEN** it SHALL contain only the declared schema fields
- **AND** no raw model reasoning trace SHALL be stored

---

### Requirement: The decision record SHALL be persisted for machine and human consumption

The validated record SHALL be written to the run directory and embedded as a single hidden,
base64-encoded artifact block in the gate's issue comment, following the existing hidden-artifact
convention. Revisions SHALL be appended as new record versions; earlier versions SHALL remain readable
so the decision → challenge → revision chain is reconstructable from the issue alone.

#### Scenario: record persisted to the run directory and the comment
- **WHEN** the gate posts its interrogation comment
- **THEN** the run directory SHALL contain the validated decision record
- **AND** the comment SHALL contain exactly one hidden decision-record artifact block decoding to that record

#### Scenario: revision preserves the prior version
- **WHEN** a decision is revised in a response round
- **THEN** the revised record SHALL be persisted as a new version
- **AND** the prior version SHALL remain retrievable for the evidence chain

