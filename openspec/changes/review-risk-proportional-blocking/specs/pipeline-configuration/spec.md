## ADDED Requirements

### Requirement: Config SHALL accept an optional `review_policy.risk_proportional` flag

`review_policy` SHALL accept an optional boolean `risk_proportional` that gates
risk-proportional `review-2` blocking (see `review-risk-proportional-blocking`).
It SHALL default to `false`, under which `review-2` blocking is identical to
behavior before this capability. A non-boolean value SHALL be rejected at
config-parse time. The resolved flag SHALL be exposed on the effective config so
the review stage can read it. Because enabling it changes review coverage, the
dotted path `review_policy.risk_proportional` SHALL be present in
`RIGOR_GATING_PATHS` and SHALL resolve to a real property in the JSON Schema
emitted by `pipeline config schema`.

#### Scenario: Flag defaults to false

- **WHEN** a repo declares no `review_policy.risk_proportional`
- **THEN** the resolved config SHALL carry `risk_proportional: false` and `review-2` blocking SHALL be unchanged from prior behavior

#### Scenario: Flag accepted when declared

- **WHEN** a repo declares `review_policy.risk_proportional: true`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `risk_proportional: true`

#### Scenario: Non-boolean value rejected

- **WHEN** `review_policy.risk_proportional` is set to a non-boolean value
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.risk_proportional` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema
