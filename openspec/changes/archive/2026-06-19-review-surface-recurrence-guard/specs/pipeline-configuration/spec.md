## ADDED Requirements

### Requirement: Config SHALL accept an optional `review_policy.surface_recurrence_rounds` setting

`review_policy` SHALL accept an optional non-negative integer
`surface_recurrence_rounds` that sets the consecutive-round threshold `N` for the
`(file + category)` surface-recurrence guard (see `review-surface-recurrence`). It
SHALL default to `3`. A value of `0` SHALL disable the surface guard. A non-integer
or negative value SHALL be rejected at config-parse time. The resolved value SHALL
be exposed on the effective config so the review stage can read it. Because it
changes review-convergence behavior, the dotted path
`review_policy.surface_recurrence_rounds` SHALL be present in `RIGOR_GATING_PATHS`
and SHALL resolve to a real property in the JSON Schema emitted by
`pipeline config schema`.

#### Scenario: Setting defaults to 3

- **WHEN** a repo declares no `review_policy.surface_recurrence_rounds`
- **THEN** the resolved config SHALL carry `surface_recurrence_rounds: 3`

#### Scenario: Value accepted when declared

- **WHEN** a repo declares `review_policy.surface_recurrence_rounds: 4`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `surface_recurrence_rounds: 4`

#### Scenario: Zero disables the guard

- **WHEN** a repo declares `review_policy.surface_recurrence_rounds: 0`
- **THEN** config resolution SHALL succeed with `surface_recurrence_rounds: 0` and the surface guard SHALL be disabled

#### Scenario: Non-integer or negative value rejected

- **WHEN** `review_policy.surface_recurrence_rounds` is set to a non-integer or a negative number
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.surface_recurrence_rounds` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema
