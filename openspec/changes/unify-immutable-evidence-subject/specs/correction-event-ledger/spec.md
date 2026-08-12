## ADDED Requirements

### Requirement: correction_event records SHALL bind an evidence_subject or an explicit unbound disposition

When the engine appends a new `correction_event` for an accepted operator correction or recovered failure, the event SHALL include either:

- a nested `evidence_subject` conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`), built from authoritative runtime state at emission time, or
- an explicit subject disposition of `legacy_unbound` / null subject only when the emission path cannot resolve a full subject under documented constraints — never an implicit claim of full multi-dimension match.

When `reviewed_sha` and `head_sha` are present as strings, and `evidence_subject` is present, `evidence_subject.candidate_sha` SHALL equal the candidate those SHA fields represent for that event (typically the reviewed or head SHA applicable to the correction). Staleness consumers SHALL prefer subject comparison when a subject is present; bare `reviewed_sha` ≠ current head remains a valid legacy signal and MUST agree with subject candidate mismatch when both are present.

#### Scenario: new correction_event carries evidence_subject

- **WHEN** a `correction_event` is emitted for an accepted override with a known candidate SHA S on run R
- **THEN** the event SHALL contain `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal S
- **AND** `evidence_subject.run_id` SHALL equal R

#### Scenario: subject candidate mismatch aligns with stale SHA lineage

- **WHEN** a correction_event’s `evidence_subject.candidate_sha` is A
- **AND** the run’s current evaluation pin candidate is B where A ≠ B
- **THEN** subject comparison SHALL report mismatch on `candidate_sha`
- **AND** consumers SHALL classify the correction lineage as stale for B the same way a `reviewed_sha` ≠ head check does today
- **AND** SHALL NOT treat the event as current for B solely because `run_id` matches

#### Scenario: historical events without subject are legacy_unbound

- **WHEN** a consumer reads a pre-migration `correction_event` that has `reviewed_sha` / `head_sha` but no `evidence_subject`
- **THEN** subject comparison SHALL return `legacy_unbound`
- **AND** the consumer MAY still apply existing reviewed_sha vs head staleness rules
- **AND** SHALL NOT claim a full subject match
