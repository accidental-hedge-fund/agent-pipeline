## Purpose

Defines the factory-gate pack-1401 clean-openspec fixture contract: one run-scoped JSON file names release 1.40.1, and a unit test verifies that value without changing production behavior.

## ADDED Requirements

### Requirement: Run-scoped clean-openspec fixture SHALL name release 1.40.1

The JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` SHALL exist and SHALL set `release_version` to the string `1.40.1`. The fixture SHALL NOT live under any other `core/test/fixtures/frg/` pack-run directory.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the file
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` is
  read as JSON
- **THEN** the `release_version` field SHALL equal `1.40.1`

#### Scenario: Fixture path is run-scoped

- **WHEN** the clean-openspec fixture for pack `pack-1401-pipeline-ship-1.40.1`
  is loaded
- **THEN** the loaded path SHALL be
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** the load SHALL NOT read a sibling pack-run directory under
  `core/test/fixtures/frg/`

### Requirement: Unit test SHALL verify the fixture release version

A unit test under `core/test/` SHALL read only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` and SHALL assert that `release_version` equals `1.40.1`. The test SHALL fail when that field is missing or has any other value.

#### Scenario: Test passes when fixture names 1.40.1

- **WHEN** the unit test runs against a fixture whose `release_version` is
  `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Test fails when fixture version changes

- **WHEN** the unit test runs against a fixture whose `release_version` is not
  `1.40.1`
- **THEN** the test SHALL fail

### Requirement: Production behavior SHALL stay unchanged

This capability SHALL add only the run-scoped fixture, the unit test, and the
OpenSpec artifacts for issue #1437. It SHALL NOT change production CLI, stage,
label, merge, or host SKILL behavior.

#### Scenario: No production source change

- **WHEN** the change is implemented
- **THEN** no production source under `core/scripts/` SHALL change
- **AND** no new CLI verb, stage, label, or merge-authority path SHALL appear
