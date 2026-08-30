## Purpose

Binds the factory-gate-v1 clean-openspec fixture for pack run
`pack-13916-pipeline-ship-1.39.16` to release `1.39.16` without changing
production pipeline behavior.

## ADDED Requirements

### Requirement: The pack-13916 clean-openspec fixture SHALL name release 1.39.16

The JSON fixture at
`core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
SHALL exist, SHALL parse as JSON, and SHALL set `release_version` to the exact
string `1.39.16`. A unit test SHALL read only that run-scoped path and SHALL
fail when `release_version` is missing or is not `1.39.16`. The fixture and
test SHALL NOT change production CLI, stage, config, or FRG-driver behavior.

#### Scenario: Fixture names release 1.39.16

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
  is parsed as JSON
- **THEN** the object SHALL contain `release_version` with the exact value
  `1.39.16`

#### Scenario: Unit test fails when the named release changes

- **WHEN** a unit test reads only
  `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
- **AND** `release_version` is missing or is not `1.39.16`
- **THEN** that test SHALL fail

#### Scenario: Production behavior stays unchanged

- **WHEN** this change is implemented
- **THEN** production modules under `core/scripts/` SHALL keep their existing
  behavior
- **AND** no production CLI, stage, config, or FRG-driver code SHALL gain new
  runtime branches for this pack run
