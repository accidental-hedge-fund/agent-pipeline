## ADDED Requirements

### Requirement: Config SHALL accept an optional `review_policy.ceiling_action` setting

`review_policy` SHALL accept an optional enum `ceiling_action` with the values
`park` and `demote_and_advance` that selects the behavior at the
`max_adversarial_rounds` round-budget ceiling (see
`review-ceiling-demote-and-advance`). It SHALL default to `park`, under which the
ceiling hard-parks at `needs-human` identically to behavior before this
capability. A value outside the enum SHALL be rejected at config-parse time. The
resolved value SHALL be exposed on the effective config so the review stage can
read it. Because it changes review-convergence behavior, the dotted path
`review_policy.ceiling_action` SHALL be present in `RIGOR_GATING_PATHS` and SHALL
resolve to a real property in the JSON Schema emitted by `pipeline config schema`.

#### Scenario: Setting defaults to park

- **WHEN** a repo declares no `review_policy.ceiling_action`
- **THEN** the resolved config SHALL carry `ceiling_action: "park"` and the round ceiling SHALL hard-park at `needs-human` unchanged from prior behavior

#### Scenario: Value accepted when declared

- **WHEN** a repo declares `review_policy.ceiling_action: demote_and_advance`
- **THEN** config resolution SHALL succeed and the effective config SHALL carry `ceiling_action: "demote_and_advance"`

#### Scenario: Out-of-enum value rejected

- **WHEN** `review_policy.ceiling_action` is set to a value other than `park` or `demote_and_advance`
- **THEN** config resolution SHALL fail with a validation error

#### Scenario: Path is registered as rigor-gating

- **WHEN** the `RIGOR_GATING_PATHS`-to-schema coherence test runs
- **THEN** `review_policy.ceiling_action` SHALL be present in `RIGOR_GATING_PATHS` and SHALL resolve to a real property in the emitted JSON Schema
