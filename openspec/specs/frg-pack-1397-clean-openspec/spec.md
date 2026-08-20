# frg-pack-1397-clean-openspec Specification

## Purpose
TBD - created by archiving change frg-pack-1397-clean-openspec. Update Purpose after archive.
## Requirements
### Requirement: The pack-1397-tugboat-ship-1.39.7 clean-openspec fixture SHALL name release 1.39.7

The pack-1397-tugboat-ship-1.39.7 clean-openspec fixture SHALL name release 1.39.7.
The run-scoped JSON fixture at
`core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json`
SHALL exist, SHALL be valid JSON, and SHALL set `release_version` to
`1.39.7`. A co-located unit test SHALL read only that path and SHALL fail
when `release_version` is missing or not equal to `1.39.7`. Production
pipeline, Factory Reliability Gate (FRG) driver, and pack-scoring behavior
SHALL remain unchanged.

#### Scenario: Fixture names release 1.39.7

- **WHEN** the file `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json` is loaded as JSON
- **THEN** the parsed object SHALL have `release_version` equal to `1.39.7`

#### Scenario: Unit test verifies the run-scoped fixture

- **WHEN** the co-located unit test for this fixture runs
- **THEN** it SHALL read `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json`
- **AND** it SHALL NOT read a fixture under any other `core/test/fixtures/frg/<pack_run_id>/` path
- **AND** it SHALL fail if `release_version` is not `1.39.7`
- **AND** it SHALL make no real network, git, or subprocess calls

#### Scenario: Production behavior is unchanged

- **WHEN** this change is implemented
- **THEN** production pipeline stages, Factory Reliability Gate (FRG) scoring, and pack templates SHALL be unmodified
- **AND** the only new runtime artifacts SHALL be the run-scoped fixture and its unit test

