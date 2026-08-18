## Purpose

Holds the run-scoped Factory Reliability Gate (FRG) clean-OpenSpec fixture
for pack `pack-1393-goal-ship-1.39.3` so the fixture names release `1.39.3`
and a unit test can check that value without changing production behavior.

## ADDED Requirements

### Requirement: The pack-1393-goal-ship-1.39.3 clean-openspec fixture SHALL name release 1.39.3

The run-scoped fixture at `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json` SHALL set `release_version` to the exact string `1.39.3`. A unit test SHALL read only that run-scoped path and SHALL fail when `release_version` is not `1.39.3`. This capability SHALL NOT change production pipeline behavior.

#### Scenario: Fixture names release 1.39.3

- **WHEN** the fixture at `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json` is loaded
- **THEN** its `release_version` field SHALL equal the string `1.39.3`

#### Scenario: Unit test fails when the fixture version is wrong

- **WHEN** a unit test reads that same run-scoped fixture path
- **AND** `release_version` is missing or is not the string `1.39.3`
- **THEN** the test SHALL fail

#### Scenario: Production pipeline behavior is unchanged

- **WHEN** this capability is implemented
- **THEN** production engine, CLI, stage, and merge behavior SHALL remain unchanged
- **AND** the change SHALL add only the run-scoped fixture, the unit test, and this OpenSpec capability
