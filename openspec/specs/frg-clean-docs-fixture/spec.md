# frg-clean-docs-fixture Specification

## Purpose
Defines the run-scoped clean-docs FRG fixture and unit-test contract so a Factory Reliability Gate pack can exercise one clean Pipeline path without changing production behavior.
## Requirements
### Requirement: Run-scoped clean-docs fixture SHALL pin release_version 1.33.0

The repository SHALL provide a JSON fixture exclusively at
`core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`.
That fixture SHALL include a `release_version` field whose value is exactly the
string `1.33.0`. The clean-docs artifact for this pack run SHALL NOT live at a
shared or non-run-scoped path under `core/test/fixtures/frg/`.

#### Scenario: Fixture present with expected version

- **WHEN** the fixture file at
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`
  is read and parsed as JSON
- **THEN** the parsed object SHALL have `release_version` equal to `1.33.0`

#### Scenario: Fixture path is run-scoped

- **WHEN** the clean-docs fixture for pack run
  `frg-1-33-0-f66627485c58a658c444ae3b` is located
- **THEN** its path SHALL be under
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/`
- **AND** SHALL NOT be a pack-run-agnostic path such as
  `core/test/fixtures/frg/clean-docs.json`

### Requirement: Unit test SHALL fail when fixture release_version changes

The test suite SHALL include a unit test that reads the run-scoped clean-docs
fixture from
`core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`
and asserts that `release_version` equals `1.33.0`. If the fixture's
`release_version` value differs from `1.33.0`, that unit test SHALL fail.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.33.0`
- **AND** the clean-docs unit test runs
- **THEN** the assertion on `release_version` SHALL pass

#### Scenario: Changed version fails

- **WHEN** the fixture `release_version` is any value other than `1.33.0`
- **AND** the clean-docs unit test runs
- **THEN** the test SHALL fail

### Requirement: Clean-docs fixture change SHALL NOT alter production behavior

Delivering this clean-docs fixture and its unit test SHALL NOT modify production
pipeline runtime behavior (stages, CLI commands, merge authority, or FRG driver
scoring). The change surface for this capability SHALL be limited to the
run-scoped fixture and its unit test under `core/test/`.

#### Scenario: Production modules remain behavior-unchanged

- **WHEN** this capability is implemented for pack run
  `frg-1-33-0-f66627485c58a658c444ae3b`
- **THEN** production modules under `core/scripts/` (excluding test and fixture
  trees) SHALL not gain new clean-docs-specific runtime behavior for this item
- **AND** merge authority and advance-never-merges policy SHALL remain unchanged

