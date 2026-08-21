## Purpose

Pins factory-gate-v1 `clean-docs` pack run `pack-1399-tugboat-ship-1.39.9`
to release `1.39.9` with a run-scoped JSON fixture and a unit test that
fails if that version changes. Production pipeline behavior stays
unchanged.

## ADDED Requirements

### Requirement: The run-scoped clean-docs fixture SHALL name release 1.39.9

The repository SHALL provide a JSON file at
`core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json`.
That file SHALL contain a `release_version` field whose value is the
string `1.39.9`.

#### Scenario: Fixture exists with pack release 1.39.9

- **WHEN** the repository is inspected at this change
- **THEN** `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json` SHALL exist
- **AND** parsing that file as JSON SHALL yield `release_version` equal to `1.39.9`

#### Scenario: Fixture path is this pack run only

- **WHEN** the fixture is added
- **THEN** it SHALL live under `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/`
- **AND** it SHALL NOT live under a different `pack_run_id` directory

### Requirement: A unit test SHALL fail when the fixture release_version is not 1.39.9

A unit test under `core/test/` SHALL read only
`core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json`
and SHALL fail when `release_version` is missing or is not the string
`1.39.9`. The test SHALL perform no real network, git, or subprocess
calls.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.39.9`
- **AND** the unit test runs as part of `core` `npm test`
- **THEN** that test SHALL pass

#### Scenario: Changed version fails

- **WHEN** the same unit test reads a fixture whose `release_version` is missing or is not `1.39.9`
- **THEN** the test SHALL fail

#### Scenario: Test does not touch other pack runs

- **WHEN** the unit test loads the fixture
- **THEN** it SHALL read `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json`
- **AND** it SHALL NOT read a fixture from another `pack_run_id` directory

### Requirement: The clean-docs instance SHALL leave production behavior unchanged

The change SHALL NOT modify production pipeline code under `core/scripts/`.
The change SHALL NOT add a merge stage, an `auto_merge` config key, or a
merge call on the advance or loop path.

#### Scenario: Production scripts are untouched

- **WHEN** this change is applied
- **THEN** no file under `core/scripts/` SHALL be modified

#### Scenario: Advance still does not merge

- **WHEN** the Pipeline for issue #1200 reaches `pipeline:ready-to-deploy`
- **THEN** advance and loop SHALL NOT merge the pull request
- **AND** the Factory Reliability Gate (FRG) MAY close the pull request and issue without merge after it records the run
