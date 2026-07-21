## MODIFIED Requirements

### Requirement: A `papercuts` config block SHALL gate the feature and SHALL reject unknown keys

The `.github/pipeline.yml` schema SHALL accept an optional strict `papercuts` block carrying an
`enabled` toggle plus the opt-in auto-file settings `auto_file` (boolean), `auto_file_window_hours`
(positive number), `auto_file_max_per_window` (positive integer), and `auto_file_min_occurrences`
(integer ≥ 2). When the block is absent, or when `papercuts.enabled` is `false`, the capture feature
SHALL be inert. When `auto_file` is absent it SHALL resolve to `false`, and every auto-file code path
SHALL be inert. An unrecognized key inside the `papercuts` block SHALL cause `resolveConfig()` to
fail with a schema error naming the offending field, consistent with how `event_sink` and other
optional strict blocks are validated.

#### Scenario: Valid block enables the feature

- **WHEN** `.github/pipeline.yml` contains `papercuts: { enabled: true }`
- **THEN** `resolveConfig()` SHALL validate successfully and resolve the feature as enabled

#### Scenario: Unknown key inside the block is rejected

- **WHEN** `.github/pipeline.yml` contains a `papercuts` block with an unrecognized key
- **THEN** `resolveConfig()` SHALL throw a schema error identifying the offending field rather
  than ignoring it

#### Scenario: Absent block leaves the feature inert

- **WHEN** `.github/pipeline.yml` contains no `papercuts` block
- **THEN** the resolved config SHALL report the feature as disabled
- **AND** SHALL report `auto_file` as `false`

#### Scenario: Auto-file keys validate and default conservatively

- **WHEN** `.github/pipeline.yml` contains `papercuts` with `enabled: true` and no `auto_file` key
- **THEN** `resolveConfig()` SHALL validate successfully
- **AND** the resolved config SHALL report `auto_file` as `false`
- **AND** SHALL expose defaulted values for `auto_file_window_hours`,
  `auto_file_max_per_window`, and `auto_file_min_occurrences`

#### Scenario: Out-of-range auto-file values are rejected

- **WHEN** `.github/pipeline.yml` sets `auto_file_max_per_window` to zero or a negative number, or
  sets `auto_file_min_occurrences` below 2
- **THEN** `resolveConfig()` SHALL throw a schema error naming the offending field rather than
  silently clamping the value
