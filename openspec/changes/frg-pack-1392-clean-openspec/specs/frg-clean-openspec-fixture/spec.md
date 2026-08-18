## Purpose

Binds the Factory Reliability Gate (FRG) clean-openspec pack-run fixture
for `pack-1392-tugboat-ship-1.39.2` to release `1.39.2` so the clean
OpenSpec path is checkable without production behavior change.

## ADDED Requirements

### Requirement: The pack-1392-tugboat-ship-1.39.2 clean-openspec fixture SHALL name release 1.39.2

The run-scoped fixture at
`core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
SHALL set `release_version` to the exact string `1.39.2`. A unit test
SHALL read only that path and SHALL fail when `release_version` is not
`1.39.2`. The fixture and test SHALL NOT change production pipeline
behavior.

#### Scenario: Fixture names release 1.39.2

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
  is loaded
- **THEN** its `release_version` field SHALL equal `1.39.2`

#### Scenario: Unit test fails when the fixture version changes

- **WHEN** a unit test reads
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
- **AND** `release_version` is not `1.39.2`
- **THEN** the test SHALL fail

#### Scenario: Fixture and test stay run-scoped

- **WHEN** the fixture and its unit test are added
- **THEN** they SHALL use only the run-scoped path
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
- **AND** they SHALL NOT change production pipeline behavior
