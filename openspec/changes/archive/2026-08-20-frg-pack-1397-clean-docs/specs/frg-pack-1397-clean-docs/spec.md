## Purpose

Pins a run-scoped clean-docs JSON fixture for Factory Reliability Gate pack `pack-1397-tugboat-ship-1.39.7` so the unit suite fails when release `1.39.7` is not recorded.

## ADDED Requirements

### Requirement: Run-scoped clean-docs fixture SHALL name release 1.39.7

The repository SHALL provide a JSON fixture at `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json`. That fixture SHALL include a `release_version` field whose value is the string `1.39.7`. The fixture SHALL NOT live under a different pack-run directory.

#### Scenario: Fixture exists at the pack-run path

- **WHEN** the repository is checked out at this change
- **THEN** file `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json` SHALL exist
- **AND** it SHALL parse as JSON

#### Scenario: Fixture release_version is 1.39.7

- **WHEN** the fixture at `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json` is read
- **THEN** its `release_version` value SHALL equal `1.39.7`

### Requirement: Unit test SHALL fail when the fixture version changes

The unit suite SHALL include a test that reads only `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json` and asserts `release_version` equals `1.39.7`. That test SHALL fail when the fixture `release_version` is any other value. The test SHALL NOT read a fixture from another pack-run directory.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.39.7`
- **AND** the unit test for this fixture runs
- **THEN** the test SHALL pass

#### Scenario: Changed version fails

- **WHEN** the fixture `release_version` is changed to a value other than `1.39.7`
- **AND** the unit test for this fixture runs
- **THEN** the test SHALL fail

### Requirement: Production pipeline behavior SHALL stay unchanged

The clean-docs fixture and its unit test SHALL NOT alter production pipeline scripts, stages, prompts, or Factory Reliability Gate driver behavior. Those two artifacts SHALL be the only product of this issue.

#### Scenario: Production scripts are untouched

- **WHEN** the implementation diff for this issue is inspected
- **THEN** files under `core/scripts/` SHALL have no content change
- **AND** generated `plugin/` SHALL not need a rebuild for this issue
