## ADDED Requirements

### Requirement: HumanInterventionKind SHALL be a derived reporting projection, not an authority classifier

The engine SHALL treat `HumanInterventionKind` as a pure reporting/metrics projection derived
from the canonical stage-diagnostic reason vocabulary and closed site context. Adding or using a
`HumanInterventionKind` value SHALL NOT by itself authorize a human hold, a `needs-human`
transition, or suppression of engine-owned recovery. In particular, `review-non-convergence`
MAY remain a reporting dimension for factory-debt metrics but MUST NOT act as the authority
classifier: unresolved review non-convergence SHALL continue to project to engine-owned
`review-findings` recovery unless a separate current `human-decision-required` diagnostic with
authority evidence is present.

#### Scenario: review-non-convergence reports without granting authority

- **WHEN** review routing records non-convergence for metrics using kind `review-non-convergence`
- **THEN** that kind alone SHALL NOT create a human hold or `needs-human` authority transition
- **AND** recovery classification SHALL follow the canonical `review-findings` (or other
  engine-owned) diagnostic projection

#### Scenario: Projection covers known intervention kinds

- **WHEN** each production intervention emission is inspected
- **THEN** its `kind` SHALL be derived from the canonical reason / blocker projection mapping
- **AND** unrecognized kinds SHALL continue to aggregate as `unknown` for consumers
)