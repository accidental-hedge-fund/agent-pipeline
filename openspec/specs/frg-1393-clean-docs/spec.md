# frg-1393-clean-docs Specification

## Purpose
Defines the run-scoped clean-docs fixture and unit test for Factory
Reliability Gate pack `pack-1393-goal-ship-1.39.3` (release `1.39.3`).

## Requirements

### Requirement: The pack-1393 clean-docs fixture SHALL name release 1.39.3

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json`.
That file SHALL parse as JSON. The fixture object SHALL include a
`release_version` field whose value is the string `1.39.3`. The
fixture SHALL NOT live under any other pack-run directory.

#### Scenario: Fixture exists at the run-scoped path

- **WHEN** the repository tree is inspected
- **THEN** `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json` SHALL exist
- **AND** that file SHALL parse as JSON
- **AND** the parsed object's `release_version` SHALL equal `1.39.3`

#### Scenario: Fixture is not stored under another pack run

- **WHEN** the clean-docs fixture for pack `pack-1393-goal-ship-1.39.3` is added
- **THEN** the fixture path SHALL include the directory segment `pack-1393-goal-ship-1.39.3`
- **AND** the fixture SHALL NOT be the sole copy under a different `pack_run_id` directory

### Requirement: A unit test SHALL fail when the fixture version is not 1.39.3

A unit test under `core/test/` SHALL read
`core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json`
and SHALL assert that `release_version` equals `1.39.3`. The test
SHALL fail if that field is missing or has any other value. The test
SHALL use that run-scoped path only. The test SHALL NOT change
production pipeline behavior.

#### Scenario: Matching fixture version passes

- **WHEN** the fixture at the run-scoped path has `release_version` equal to `1.39.3`
- **AND** the unit test suite under `core/test/` runs
- **THEN** the clean-docs fixture test SHALL pass

#### Scenario: Changed fixture version fails

- **WHEN** the fixture at the run-scoped path has `release_version` set to a value other than `1.39.3`
- **AND** the unit test suite under `core/test/` runs
- **THEN** the clean-docs fixture test SHALL fail

#### Scenario: Missing release_version fails

- **WHEN** the fixture at the run-scoped path omits `release_version`
- **AND** the unit test suite under `core/test/` runs
- **THEN** the clean-docs fixture test SHALL fail

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL NOT alter production pipeline stages, Factory
Reliability Gate scoring, merge commands, or label transitions. The
fixture and unit test SHALL be the only intended product of the
implementation.

#### Scenario: Production scripts are not required to change

- **WHEN** implementation of this change is complete
- **THEN** production modules under `core/scripts/` SHALL keep their existing behavior
- **AND** merge and Factory Reliability Gate close-without-merge behavior SHALL stay outside this change
