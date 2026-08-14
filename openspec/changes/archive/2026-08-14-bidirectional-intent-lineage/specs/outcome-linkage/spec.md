## ADDED Requirements

### Requirement: Production outcomes SHALL be projectable into the intent-lineage graph without a parallel attribution model

When lineage ingest is available, each `production_outcome` and its `attribution` entries SHALL be projectable into intent-lineage nodes and edges that preserve:

- multi-target many-to-many attribution
- `authority` values `observed` vs `inferred`
- disputed and missing-link diagnostics

Lineage projection SHALL reuse outcome_id and attribution target identities rather than minting a second incompatible attribution store. Projection SHALL NOT collapse multiple outcomes into a single maintainability score.

#### Scenario: observed run attribution becomes an observed lineage edge

- **WHEN** an outcome has a run attribution with `authority: "observed"`
- **THEN** the projected lineage edge for that run target SHALL carry authority `observed`
- **AND** SHALL reference the same `run_id` target identity

#### Scenario: inferred attribution remains inferred in lineage

- **WHEN** an outcome has only an inferred component attribution
- **THEN** the projected lineage edge SHALL carry authority `inferred`
- **AND** reporting consumers SHALL NOT present it as observed fact

#### Scenario: many-to-many outcomes attach without score collapse

- **WHEN** two outcomes attribute the same commit with different kinds
- **THEN** both SHALL project as distinct outcome nodes or edges
- **AND** lineage SHALL NOT require a single combined score field
