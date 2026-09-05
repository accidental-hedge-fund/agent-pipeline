# frg-pack-1401-pipeline-ship-clean-openspec Specification

## Purpose
TBD - created by archiving change frg-pack-1401-clean-openspec. Update Purpose after archive.
## Requirements
### Requirement: The pack-1401-pipeline-ship-1.40.1 clean-openspec fixture SHALL name release 1.40.1

The JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` SHALL set field `release_version` to the string `1.40.1`. A unit test SHALL read only that run-scoped path and SHALL fail when `release_version` is not `1.40.1`. Production pipeline behavior SHALL remain unchanged.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the file `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` is read as JSON
- **THEN** field `release_version` SHALL equal `1.40.1`

#### Scenario: Unit test fails when the fixture version changes

- **WHEN** a unit test reads that same run-scoped fixture path
- **AND** `release_version` is not `1.40.1`
- **THEN** the test SHALL fail

#### Scenario: Production behavior stays unchanged

- **WHEN** this requirement is implemented
- **THEN** production CLI, stage, merge, and Factory Reliability Gate driver behavior SHALL remain unchanged

