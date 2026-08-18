# frg-pack-clean-docs-fixture Specification

## Purpose
Binds the pack-1392-tugboat-ship-1.39.2 clean-docs Factory Reliability Gate
(FRG) item to one run-scoped JSON fixture and a unit test that fails when
`release_version` is not `1.39.2`. Production pipeline behavior stays unchanged.

## Requirements

### Requirement: The pack-1392-tugboat-ship-1.39.2 clean-docs fixture SHALL live only at the run-scoped path

The pack-1392-tugboat-ship-1.39.2 clean-docs fixture SHALL exist at
`core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`. The
unit test for this item SHALL read only that path. The test SHALL NOT load a
fixture from another `core/test/fixtures/frg/<pack_run_id>/` directory for this
item.

#### Scenario: Fixture is present at the run-scoped path

- **WHEN** the test suite loads the clean-docs fixture for pack run
  `pack-1392-tugboat-ship-1.39.2`
- **THEN** it SHALL read
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`
- **AND** that file SHALL parse as JSON

#### Scenario: Other pack-run fixture paths are not used

- **WHEN** the unit test for this clean-docs item runs
- **THEN** it SHALL NOT read
  `core/test/fixtures/frg/` paths that omit
  `pack-1392-tugboat-ship-1.39.2`

### Requirement: The clean-docs fixture SHALL declare release_version 1.39.2

The JSON object at `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json` SHALL include a `release_version` field whose value is the string `1.39.2`.

#### Scenario: Fixture version matches the pack release

- **WHEN** the run-scoped clean-docs fixture is parsed
- **THEN** its `release_version` field SHALL equal `1.39.2`

### Requirement: A unit test SHALL fail when the fixture release_version is not 1.39.2

A unit test SHALL parse the run-scoped clean-docs fixture and assert that
`release_version` equals `1.39.2`. The test SHALL fail when that field is
missing or has any other value.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.39.2`
- **AND** the unit test runs
- **THEN** the assertion on `release_version` SHALL pass

#### Scenario: Changed version fails

- **WHEN** the fixture `release_version` is missing or is not `1.39.2`
- **AND** the unit test runs
- **THEN** the test SHALL fail

### Requirement: The clean-docs pack item SHALL NOT change production pipeline behavior

The clean-docs pack item SHALL add only the run-scoped fixture and its unit
test. The item SHALL NOT change production stage, CLI, config, or prompt
behavior.

#### Scenario: Production scripts stay unchanged

- **WHEN** this change is applied
- **THEN** production pipeline behavior SHALL remain the same as before the
  fixture and test were added
- **AND** the new files SHALL be limited to the run-scoped fixture and the
  unit test that reads it
