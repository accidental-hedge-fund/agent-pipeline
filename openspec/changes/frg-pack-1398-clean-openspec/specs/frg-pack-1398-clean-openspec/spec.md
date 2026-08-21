## Purpose

Defines the run-scoped Factory Reliability Gate (FRG) clean-openspec
fixture for pack `pack-1398-tugboat-ship-1.39.8`. The fixture names
release `1.39.8`. A unit test verifies that value. Production engine
behavior does not change.

## ADDED Requirements

### Requirement: The pack-1398 clean-openspec fixture SHALL name release 1.39.8

The pack-1398 clean-openspec fixture SHALL name release `1.39.8`.
The JSON fixture at
`core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json`
SHALL expose that value on the `release_version` field as the string
`1.39.8`. A unit test SHALL read only that run-scoped path and SHALL
fail when `release_version` is missing or is not `1.39.8`. Production
engine modules under `core/scripts/` SHALL keep their current behavior.

#### Scenario: Fixture names release 1.39.8

- **WHEN** the file
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json`
  is parsed as JSON
- **THEN** the parsed object SHALL contain `release_version`
- **AND** `release_version` SHALL equal the string `1.39.8`

#### Scenario: Unit test fails when the named release changes

- **WHEN** a unit test under `core/test/` reads only
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json`
- **AND** `release_version` is missing or is not the string `1.39.8`
- **THEN** that test SHALL fail
- **AND** the test SHALL NOT read any other `core/test/fixtures/frg/`
  pack directory

#### Scenario: Production engine behavior stays unchanged

- **WHEN** this change is implemented
- **THEN** no production module under `core/scripts/` SHALL change
  observable behavior
- **AND** the change SHALL consist of the run-scoped fixture, the unit
  test, and this OpenSpec capability
