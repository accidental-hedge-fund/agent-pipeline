# frg-pack-13911-clean-openspec Specification

## Purpose
Define the run-scoped FRG clean-OpenSpec fixture for pack
`pack-13911-tugboat-ship-1.39.11` so the fixture names release `1.39.11`
and a unit test proves that value.

## Requirements

### Requirement: The pack-13911 clean-OpenSpec fixture SHALL name release 1.39.11

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`.
That fixture SHALL set `release_version` to the exact string `1.39.11`.
A unit test SHALL read that run-scoped path and SHALL fail when
`release_version` is missing or is not `1.39.11`. The fixture and the test
SHALL NOT change production pipeline behavior.

#### Scenario: Fixture names release 1.39.11

- **WHEN** the file `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json` is loaded
- **THEN** its `release_version` field SHALL equal `1.39.11`

#### Scenario: Unit test fails on a wrong or missing release

- **WHEN** a unit test reads `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`
- **AND** `release_version` is missing or is not `1.39.11`
- **THEN** that test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the fixture and the unit test are inspected
- **THEN** they SHALL reference only
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`
- **AND** they SHALL NOT write or require a fixture under a different pack run id
