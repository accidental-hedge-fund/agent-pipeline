## Purpose

Defines the pack-1401-pipeline-ship-1.40.1 clean-openspec fixture contract so the synthetic Factory Reliability Gate OpenSpec path can name release 1.40.1 at a run-scoped path.

## ADDED Requirements

### Requirement: Pack-1401 clean-openspec fixture SHALL name release 1.40.1

The run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` SHALL set `release_version` to `1.40.1`. A unit test SHALL read only that path and SHALL fail when `release_version` is not `1.40.1`. Production pipeline behavior SHALL NOT change for this fixture.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the file `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` is parsed as JSON
- **THEN** its `release_version` field SHALL equal the string `1.40.1`

#### Scenario: Unit test fails when the fixture version changes

- **WHEN** a unit test reads `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** `release_version` is not `1.40.1`
- **THEN** that test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the clean-openspec fixture for pack run `pack-1401-pipeline-ship-1.40.1` is loaded by its unit test
- **THEN** the test SHALL read `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** SHALL NOT read a fixture from another pack-run directory
