# frg-pack-1396-clean-openspec Specification

## Purpose
Holds the run-scoped Factory Reliability Gate (FRG) OpenSpec fixture
for pack `pack-1396-tugboat-ship-1.39.6` and the requirement that it
names release `1.39.6`.

## Requirements

### Requirement: The pack-1396 clean-openspec fixture SHALL name release 1.39.6

The pack-1396 clean-openspec fixture SHALL name release `1.39.6`. The JSON fixture at `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json` SHALL set `release_version` to the exact string `1.39.6`. A unit test SHALL read only that run-scoped path and SHALL fail when the field is missing or is not `1.39.6`. Production modules under `core/scripts/` SHALL keep their existing runtime behavior.

#### Scenario: Fixture names the pack release

- **WHEN** the JSON fixture at
  `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`
  is read
- **THEN** the field `release_version` SHALL equal `1.39.6`

#### Scenario: Unit test fails on a different release

- **WHEN** the fixture's `release_version` is missing or is not `1.39.6`
- **THEN** the unit test that reads that run-scoped path SHALL fail

#### Scenario: Production behavior is unchanged

- **WHEN** this change is applied
- **THEN** no production module under `core/scripts/` SHALL change
  runtime behavior
- **AND** the fixture and test SHALL use only the run-scoped path
  `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`
