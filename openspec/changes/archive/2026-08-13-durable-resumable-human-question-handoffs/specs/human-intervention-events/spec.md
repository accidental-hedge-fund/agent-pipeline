## ADDED Requirements

### Requirement: Handoff lifecycle MAY correlate with human_intervention events without replacing the taxonomy

When a human-question handoff is created at a pipeline block or exit that already emits a `human_intervention` event, the event payload or a linked evidence field SHALL be able to carry the `handoff_id` for correlation. Emitting or correlating a handoff SHALL NOT add, remove, or rename `HumanInterventionKind` members solely for handoff support, and SHALL NOT treat intervention kind as authority. Handoff class and authority_mode remain the handoff contract; intervention kind remains a reporting projection.

#### Scenario: Create at a block can link handoff_id on the intervention event

- **WHEN** a stage parks with a human_intervention emission and creates handoff H
- **THEN** the intervention event or its linked evidence SHALL be able to reference H's `handoff_id`
- **AND** the `kind` field SHALL remain a valid existing `HumanInterventionKind` value

#### Scenario: Intervention kind alone does not authorize resume

- **WHEN** a consumer sees `kind: product-judgment-required` without a valid answered authority-bearing handoff and without current human-decision-required evidence as required by other specs
- **THEN** that kind alone SHALL NOT authorize item advance
- **AND** handoff resume rules SHALL still apply independently
