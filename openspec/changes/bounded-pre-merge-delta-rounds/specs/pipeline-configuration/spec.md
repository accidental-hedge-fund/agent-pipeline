## ADDED Requirements

### Requirement: `review_policy.max_delta_rounds` SHALL cap pre-merge delta rounds and default to 4

The pipeline configuration SHALL accept `review_policy.max_delta_rounds`: a positive integer capping the number of pre-merge delta review rounds performed for a single item. Its default SHALL be `4`. The config schema SHALL reject a value that is not a positive integer. The key SHALL appear in the configuration key allowlist so a typo is reported rather than silently ignored, SHALL be described in the machine-readable config schema output, and SHALL be rendered as a documented optional key in scaffolded configuration. There SHALL be no sentinel value meaning "unbounded".

#### Scenario: Default applies when the key is absent

- **WHEN** a repository configuration omits `review_policy.max_delta_rounds`
- **THEN** the resolved configuration SHALL report `max_delta_rounds: 4`

#### Scenario: Explicit value is honored

- **WHEN** a repository configuration sets `review_policy.max_delta_rounds: 2`
- **THEN** the resolved configuration SHALL report `max_delta_rounds: 2`

#### Scenario: Non-positive and non-integer values are rejected

- **WHEN** a repository configuration sets `review_policy.max_delta_rounds` to `0`, to a negative number, or to a non-integer
- **THEN** configuration validation SHALL fail with an error naming the key

#### Scenario: Key is recognized by the allowlist and schema surfaces

- **WHEN** the configuration key allowlist and the machine-readable config schema output are inspected
- **THEN** both SHALL include `review_policy.max_delta_rounds`
- **AND** a misspelling of the key in a repository configuration SHALL be reported as an unknown key
