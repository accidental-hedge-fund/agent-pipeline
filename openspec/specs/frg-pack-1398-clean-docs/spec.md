# frg-pack-1398-clean-docs Specification

## Purpose
TBD - created by archiving change frg-pack-1398-clean-docs. Update Purpose after archive.
## Requirements
### Requirement: The pack-1398 clean-docs fixture SHALL name release 1.39.8

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`. That
fixture SHALL include a `release_version` field whose value is the string
`1.39.8`. The fixture SHALL NOT live under a different pack-run directory.

#### Scenario: Fixture exists at the run-scoped path

- **WHEN** the repository is inspected for the pack-1398 `clean-docs` fixture
- **THEN** the file `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` SHALL exist
- **AND** that file SHALL be valid JSON
- **AND** no other `core/test/fixtures/frg/<pack_run_id>/` path SHALL be required for this instance

#### Scenario: Fixture release_version is 1.39.8

- **WHEN** that fixture is parsed as JSON
- **THEN** the `release_version` field SHALL equal `1.39.8`

---

### Requirement: A unit test SHALL fail when the pack-1398 fixture version changes

A unit test under `core/test/` SHALL read only
`core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` and SHALL
assert that `release_version` equals `1.39.8`. The test SHALL fail when that
field is missing or holds any other value. The test SHALL NOT change production
engine behavior.

#### Scenario: Test passes when the fixture version is 1.39.8

- **WHEN** the unit test reads the run-scoped fixture
- **AND** `release_version` is `1.39.8`
- **THEN** the test SHALL pass

#### Scenario: Test fails when the fixture version changes

- **WHEN** the unit test reads the run-scoped fixture
- **AND** `release_version` is not `1.39.8`
- **THEN** the test SHALL fail

#### Scenario: Test does not use another pack path

- **WHEN** the unit test loads the fixture
- **THEN** it SHALL read `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`
- **AND** it SHALL NOT read a fixture under a different `pack_run_id` directory

