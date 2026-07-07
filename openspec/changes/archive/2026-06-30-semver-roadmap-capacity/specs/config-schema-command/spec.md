## ADDED Requirements

### Requirement: `pipeline config schema` SHALL expose the `roadmap.release_capacity` block

The JSON Schema emitted by `pipeline config schema` SHALL include, under the `roadmap` property, a
`release_capacity` sub-property derived from `PartialConfigSchema`. Its `effort_budget`
sub-property SHALL be typed as a number and `isolate_breaking` SHALL be typed as a boolean; each
SHALL carry a non-empty `description` that names the release-capacity signal it controls.
`release_capacity` SHALL be absent from the schema's `required` arrays (it is optional). The
schema output SHALL stay in sync with `PartialConfigSchema` without any separate update step.

#### Scenario: schema includes release_capacity with accurate types

- **WHEN** the user runs `pipeline config schema`
- **THEN** the emitted JSON Schema SHALL include a `roadmap.properties.release_capacity` property
- **AND** `release_capacity.properties.effort_budget` SHALL describe a number with a non-empty `description`
- **AND** `release_capacity.properties.isolate_breaking` SHALL describe a boolean with a non-empty `description`
- **AND** `release_capacity` SHALL NOT appear in any `required` array

#### Scenario: descriptions name the release-capacity signals

- **WHEN** the user runs `pipeline config schema`
- **THEN** the `effort_budget` and `isolate_breaking` descriptions SHALL each be a non-empty string suitable for editor tooltip display
- **AND** SHALL describe how the field tunes capacity-aware semver milestone grouping
