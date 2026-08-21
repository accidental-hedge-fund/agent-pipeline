## Purpose

Pins the Factory Reliability Gate pack `pack-13910-tugboat-ship-1.39.10` clean-docs
fixture to release `1.39.10` and requires a unit test that fails if that version changes.

## ADDED Requirements

### Requirement: Run-scoped clean-docs fixture names release 1.39.10

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json` whose
`release_version` value is the string `1.39.10`.

#### Scenario: Fixture is present at the pack-run path

- **WHEN** the repository is checked out with this change
- **THEN** file `core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json`
  SHALL exist
- **AND** it SHALL parse as JSON
- **AND** its `release_version` field SHALL equal `1.39.10`

#### Scenario: Fixture is not shared with another pack run

- **WHEN** a test or implementer locates the clean-docs fixture for this pack
- **THEN** the path SHALL use pack-run id `pack-13910-tugboat-ship-1.39.10` only
- **AND** SHALL NOT read `core/test/fixtures/frg/` directories for any other
  `pack_run_id`

### Requirement: Unit test pins the fixture release version

A unit test under `core/test/` SHALL read only
`core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json` and SHALL
fail when that fixture's `release_version` is not `1.39.10`.

#### Scenario: Matching release version passes

- **WHEN** the fixture's `release_version` is `1.39.10`
- **AND** the unit test runs
- **THEN** the test SHALL pass

#### Scenario: Changed release version fails

- **WHEN** the fixture's `release_version` is any value other than `1.39.10`
- **AND** the unit test runs
- **THEN** the test SHALL fail

### Requirement: Production pipeline behavior stays unchanged

This change SHALL NOT alter production pipeline behavior under `core/scripts/`.

#### Scenario: No production script edit

- **WHEN** the change is applied
- **THEN** files under `core/scripts/` SHALL be unmodified
- **AND** Factory Reliability Gate scoring, advance, merge, and stage logic SHALL
  behave as they did before this change
