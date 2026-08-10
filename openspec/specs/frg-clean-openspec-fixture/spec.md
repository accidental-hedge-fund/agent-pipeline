# frg-clean-openspec-fixture Specification

## Purpose
Defines the run-scoped FRG clean-OpenSpec JSON fixture for pack run
`frg-1-33-0-f66627485c58a658c444ae3b`: path isolation, release identity
`1.33.0`, and the unit-test guard that pins that value without changing
production pipeline behavior.
## Requirements
### Requirement: The clean-OpenSpec FRG fixture SHALL name release 1.33.0 at the run-scoped path

The repository SHALL provide a JSON fixture file at exactly

`core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json`.

That file SHALL be valid JSON and SHALL declare a top-level string field
`release_version` whose value is exactly `1.33.0`. The fixture exists to exercise
one clean Pipeline path that includes an OpenSpec change and archive for Factory
Reliability Gate pack run `frg-1-33-0-f66627485c58a658c444ae3b`. Adding or changing
this fixture SHALL NOT alter production pipeline stage behavior, CLI surface, or
configuration defaults.

#### Scenario: Fixture exists at the run-scoped path with release 1.33.0

- **WHEN** the fixture file at
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json`
  is read and parsed as JSON
- **THEN** parsing SHALL succeed
- **AND** the top-level field `release_version` SHALL equal the string `1.33.0`

#### Scenario: Wrong release value is rejected by the unit test

- **WHEN** the fixture's `release_version` is not exactly `1.33.0` (for example
  `1.32.0` or an empty string)
- **THEN** the unit test that loads this run-scoped fixture path SHALL fail

#### Scenario: Production behavior is unchanged

- **WHEN** this capability is implemented
- **THEN** no production stage, harness, or config module under `core/scripts/`
  SHALL change as a result of this fixture and its unit test alone

