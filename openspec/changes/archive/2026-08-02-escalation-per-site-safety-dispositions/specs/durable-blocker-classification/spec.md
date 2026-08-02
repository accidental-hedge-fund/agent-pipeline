## ADDED Requirements

### Requirement: DurableBlockerClass SHALL be an exhaustive projection of canonical stage-diagnostic reasons

The engine SHALL treat `DurableBlockerClass` as an exhaustive pure projection of the closed
`pipeline/stage-diagnostic@1` reason-code vocabulary (via the existing
`projectPipelineReasonCode` / equivalent projection), not as an independently authored authority
taxonomy. Every reason code SHALL map to exactly one durable class or to the existing protocol
`workflow-engine-defect` failure path for unknown codes. Recovery policy compilation, per-item
`blocked_theme`, and recovery budget maps SHALL key only members of that closed durable set.

#### Scenario: Every reason code has a durable class

- **WHEN** the projection is evaluated for each closed stage-diagnostic reason code
- **THEN** it SHALL return exactly one `DurableBlockerClass`
- **AND** the recovery policy SHALL contain a compiled entry for that class

#### Scenario: Orphan budget keys are rejected

- **WHEN** a recovery budget map or policy document names a class outside the closed
  `DurableBlockerClass` set projected from the canonical vocabulary
- **THEN** validation or compilation SHALL fail closed
- **AND** the run SHALL NOT start with a parallel unofficial taxonomy key

#### Scenario: Loop recovery budgets consume the same enum

- **WHEN** the durable loop supervisor charges or consults per-class recovery budgets
- **THEN** the budget key SHALL be a `DurableBlockerClass` member projected from the item's
  canonical diagnostic reason
- **AND** SHALL NOT use a separate ad-hoc string taxonomy parallel to stage diagnostics
)