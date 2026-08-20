## Purpose

Defines the run-scoped `clean-docs` fixture and unit test for Factory
Reliability Gate pack `pack-1395-tugboat-ship-1.39.5` on release `1.39.5`.

## ADDED Requirements

### Requirement: Pack 1395 clean-docs fixture SHALL name release 1.39.5
The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json` whose
`release_version` field is the string `1.39.5`. The fixture SHALL live only
under that pack-run directory.

#### Scenario: Fixture exists at the run-scoped path
- **WHEN** the repository tree is inspected
- **THEN** `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
  SHALL exist
- **AND** the file SHALL parse as JSON
- **AND** the parsed object's `release_version` field SHALL equal `1.39.5`

#### Scenario: Fixture is not shared with another pack run
- **WHEN** the fixture path is resolved
- **THEN** the path SHALL include `pack-1395-tugboat-ship-1.39.5`
- **AND** SHALL NOT use a sibling `core/test/fixtures/frg/<other-pack-run-id>/`
  directory

### Requirement: Pack 1395 clean-docs unit test SHALL fail on a version mismatch
The unit-test suite SHALL include a test that reads only
`core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json` and
asserts that `release_version` equals `1.39.5`. Replacing that field with any
other value SHALL make the test fail.

#### Scenario: Test passes when the fixture version is 1.39.5
- **WHEN** the fixture `release_version` is `1.39.5`
- **AND** the unit-test suite runs
- **THEN** the pack-1395 clean-docs test SHALL pass

#### Scenario: Test fails when the fixture version changes
- **WHEN** the fixture `release_version` is changed to a value other than
  `1.39.5`
- **AND** the unit-test suite runs
- **THEN** the pack-1395 clean-docs test SHALL fail

#### Scenario: Test fails when release_version is missing
- **WHEN** the fixture omits `release_version`
- **AND** the unit-test suite runs
- **THEN** the pack-1395 clean-docs test SHALL fail

### Requirement: Pack 1395 clean-docs change SHALL NOT alter production behavior
The pack-1395 clean-docs change SHALL NOT modify production source under
`core/scripts/`, `hosts/`, or `plugin/`. The change SHALL add only the
run-scoped fixture and its unit test.

#### Scenario: Production tree is unchanged
- **WHEN** the change is implemented
- **THEN** no file under `core/scripts/`, `hosts/`, or `plugin/` SHALL be
  added, removed, or edited
- **AND** runtime pipeline behavior SHALL remain unchanged
