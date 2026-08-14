## ADDED Requirements

### Requirement: Governed override decisions SHALL bind the shared evidence_subject

When the engine records a readiness-relevant override decision, it SHALL attach an engine-built `evidence_subject` (schema version 1 field set) derived from authoritative runtime state — not from the operator free-text reason. The pipeline SHALL NOT invent a second subject vocabulary for overrides. Historical decisions without a subject SHALL be classified under the existing transitional `legacy_unbound` comparison outcome and handled by the compatibility rules in `governed-overrides`.

#### Scenario: new override decision carries evidence_subject

- **WHEN** an authorized override decision is recorded for a known candidate
- **THEN** the decision record SHALL include `evidence_subject` with `schema_version: 1` and the required v1 fields
- **AND** those fields SHALL come from engine-resolved runtime state

#### Scenario: free-text reason does not supply subject fields

- **WHEN** an operator writes a candidate SHA or policy identity into the override explanation
- **THEN** the producer SHALL ignore that prose for `evidence_subject` fields
- **AND** SHALL populate the subject only from engine-resolved state

### Requirement: Subject mismatch SHALL render override decisions non-current for unblock

Consumers that decide whether an override decision may exclude a finding from the blocking set SHALL compare the decision’s `evidence_subject` to the evaluation pin using the shared comparison rules. On `mismatch` for governed dimensions (at least candidate, policy, verifier, and ownership/component-related dimensions used by override currency) or on `malformed`, the decision SHALL be non-current for unblock. On `legacy_unbound`, consumers SHALL apply only the documented compatibility disposition and SHALL NOT treat the decision as high-risk authority evidence.

#### Scenario: candidate mismatch blocks reuse of override

- **WHEN** a decision subject’s `candidate_sha` differs from the evaluation pin
- **THEN** comparison SHALL return `mismatch` including `candidate_sha`
- **AND** the override SHALL NOT unblock under the new pin

#### Scenario: malformed override subject is not a match

- **WHEN** a decision’s subject is missing required v1 fields
- **THEN** comparison SHALL return `malformed`
- **AND** the decision SHALL NOT be treated as currently valid for unblock
