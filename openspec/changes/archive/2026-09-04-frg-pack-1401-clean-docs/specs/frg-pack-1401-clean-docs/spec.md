## Purpose

Holds the factory-gate `clean-docs` proof for pack `pack-1401-pipeline-ship-1.40.1`: one run-scoped JSON fixture and one unit test that pin `release_version` to `1.40.1` without changing production behavior.

## ADDED Requirements

### Requirement: The pack-1401 clean-docs fixture SHALL name release 1.40.1 at the run-scoped path

The repository SHALL contain a JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. That fixture SHALL parse as JSON. Its `release_version` field SHALL be the string `1.40.1`. The fixture SHALL NOT live at a path outside that pack-run directory.

#### Scenario: Fixture exists at the run-scoped path

- **WHEN** the repository is inspected at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **THEN** the file SHALL exist
- **AND** the file SHALL parse as JSON

#### Scenario: Fixture release_version is 1.40.1

- **WHEN** the JSON object at that run-scoped path is read
- **THEN** its `release_version` field SHALL equal the string `1.40.1`

### Requirement: A unit test SHALL fail when the pack-1401 clean-docs fixture version changes

The test suite SHALL include a unit test that reads only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and asserts that `release_version` equals `1.40.1`. That test SHALL fail when the fixture's `release_version` is any other value. The test SHALL NOT read a fixture from another pack-run directory.

#### Scenario: Test passes against the committed fixture

- **WHEN** `cd core && npm test` runs against the committed fixture
- **THEN** the unit test that reads the pack-1401 clean-docs fixture SHALL pass

#### Scenario: Test fails when release_version changes

- **WHEN** the fixture's `release_version` is changed to a value other than `1.40.1`
- **AND** the same unit test runs
- **THEN** that test SHALL fail

### Requirement: The pack-1401 clean-docs change SHALL NOT alter production behavior

The change SHALL add only the run-scoped fixture and its unit test. It SHALL NOT change production CLI verbs, stage modules, merge authority, or Factory Reliability Gate engine code.

#### Scenario: Production surfaces stay unchanged

- **WHEN** the change is implemented
- **THEN** production files under `core/scripts/` SHALL remain unmodified
- **AND** no new public CLI verb SHALL be added
- **AND** advance and loop SHALL still not merge
