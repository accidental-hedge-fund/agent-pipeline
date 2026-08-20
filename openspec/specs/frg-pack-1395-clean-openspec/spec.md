# frg-pack-1395-clean-openspec Specification

## Purpose
Records the run-scoped Factory Reliability Gate (FRG) clean-openspec fixture for pack `pack-1395-tugboat-ship-1.39.5` so the fixture names release `1.39.5` and a unit test can verify that value without changing production engine behavior.

## Requirements

### Requirement: The pack-1395 clean-openspec fixture SHALL name release 1.39.5

The JSON fixture at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` SHALL name release `1.39.5`. A unit test SHALL fail when that fixture is missing, is not valid JSON, or names a different release. The fixture and the test SHALL use only that run-scoped path. Production engine behavior SHALL remain unchanged.

#### Scenario: Fixture names release 1.39.5

- **WHEN** the JSON file at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` is loaded
- **THEN** the fixture SHALL expose a `release_version` field whose value is exactly `1.39.5`

#### Scenario: Unit test fails on a wrong release value

- **WHEN** the fixture is missing, is not valid JSON, or `release_version` is not exactly `1.39.5`
- **THEN** the unit test that reads that run-scoped fixture SHALL fail

#### Scenario: Production engine behavior is unchanged

- **WHEN** this change is implemented
- **THEN** no production runtime file under `core/scripts/`, `hosts/`, or `plugin/` SHALL change
- **AND** the fixture and test SHALL live only under `core/test/`
