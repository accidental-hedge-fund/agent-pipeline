## Purpose

Pins a run-scoped factory-gate clean-docs JSON fixture for pack run
`pack-13911-tugboat-ship-1.39.11` and a unit test that fails if
`release_version` is not `1.39.11`. Production pipeline behavior stays
unchanged.

## ADDED Requirements

### Requirement: Pack-13911 clean-docs fixture SHALL pin release 1.39.11

The run-scoped JSON fixture SHALL exist at
`core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`
and SHALL set `release_version` to the string `1.39.11`.
The fixture path SHALL be scoped to pack run
`pack-13911-tugboat-ship-1.39.11` only.

#### Scenario: Fixture exists at the pack-run path with release 1.39.11

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`
  is read as JSON
- **THEN** the parsed object SHALL have `release_version` equal to `1.39.11`

#### Scenario: Fixture is not stored under another pack-run path

- **WHEN** the clean-docs fixture for pack run
  `pack-13911-tugboat-ship-1.39.11` is located
- **THEN** its path SHALL be exactly
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`

### Requirement: Unit test SHALL fail when the fixture version changes

A unit test in `core/test/` SHALL read only the run-scoped fixture path
`core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`
and SHALL fail when the parsed `release_version` is not the string
`1.39.11`.

#### Scenario: Test fails on a changed release_version

- **WHEN** the fixture's `release_version` is any value other than `1.39.11`
- **THEN** the unit test SHALL fail

#### Scenario: Test reads only the run-scoped path

- **WHEN** the unit test loads the clean-docs fixture
- **THEN** it SHALL read
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`
- **AND** it SHALL NOT read a fixture path for a different pack_run_id

### Requirement: Clean-docs pack instance SHALL NOT change production pipeline behavior

The `pack-13911-tugboat-ship-1.39.11` clean-docs change SHALL NOT modify
production pipeline scripts, host packaging, generated plugin output, or
merge authority.

#### Scenario: Production surfaces stay unchanged

- **WHEN** this change is applied
- **THEN** files under `core/scripts/`, `hosts/`, and `plugin/` SHALL remain
  unchanged by this change
- **AND** the change SHALL NOT add merge authority or a merge stage
