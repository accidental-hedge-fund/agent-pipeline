## Purpose

Defines the run-scoped Factory Reliability Gate (FRG) pack fixture for `pack-1395-tugboat-ship-1.39.5` so the clean OpenSpec path can prove the fixture names release `1.39.5` without changing production behavior.

## ADDED Requirements

### Requirement: Pack-1395 clean-openspec fixture names release 1.39.5

The run-scoped JSON fixture at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` SHALL name release `1.39.5`. A unit test SHALL read only that run-scoped path and verify the named release. The fixture and the test SHALL NOT change production behavior.

#### Scenario: Fixture names release 1.39.5

- **WHEN** the fixture at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` is loaded
- **THEN** the fixture SHALL name release `1.39.5`

#### Scenario: Unit test verifies the run-scoped release value

- **WHEN** the unit test for this pack run executes
- **THEN** it SHALL read only `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json`
- **AND** it SHALL pass when that fixture names release `1.39.5`
- **AND** it SHALL fail when that fixture names a different release

#### Scenario: Production behavior is unchanged

- **WHEN** the fixture and unit test are added
- **THEN** production runtime, CLI, and stage behavior SHALL remain unchanged
