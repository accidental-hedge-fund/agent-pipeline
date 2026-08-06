## ADDED Requirements

### Requirement: Candidate-integrity scope expansion SHALL invalidate prior review as readiness authority

The review-SHA gate and readiness paths that consume review evidence SHALL treat prior review verdicts for the pre-mutation candidate as not sufficient authority for the post-mutation head when candidate-integrity classifies a pipeline-owned mutation as `scope_expansion` or `unverified`. This invalidation SHALL apply even if residual identity heuristics might otherwise look reusable. Exact-SHA match and pipeline-internal-only exemptions on an unchanged head remain unchanged; this requirement applies to classified candidate-moving mutations and unverified transitions, not to ordinary no-movement cases.

#### Scenario: Scope expansion blocks verdict reuse for readiness

- **WHEN** candidate-integrity reports `scope_expansion` for a mutation from SHA `A` to SHA `B`
- **AND** the most recent approve verdict was recorded against SHA `A` or its pre-mutation surface
- **THEN** the gate SHALL NOT treat that verdict as readiness authority for SHA `B`
- **AND** SHALL require review (or the existing delta-review path when applicable) of the current head before further readiness progress

#### Scenario: Unverified mutation blocks verdict reuse

- **WHEN** candidate-integrity reports `unverified` for a claimed head movement
- **THEN** the gate SHALL NOT reuse pre-mutation review evidence for ready-to-deploy on the unconfirmed head

#### Scenario: Semantic equivalence does not invent a free pass past unresolved blockers

- **WHEN** candidate-integrity reports `semantically_equivalent`
- **AND** the current review evidence still carries unresolved blocking keys under existing gate rules
- **THEN** those unresolved blockers SHALL still hold the gate
- **AND** semantic equivalence SHALL NOT clear blocking keys
