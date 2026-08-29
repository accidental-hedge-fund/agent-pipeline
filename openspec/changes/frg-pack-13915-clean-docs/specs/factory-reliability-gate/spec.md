## ADDED Requirements

### Requirement: The clean-docs pack instance for pack-13915-pipeline-ship-1.39.15 SHALL land a run-scoped fixture and pinning test

The Factory Reliability Gate (FRG) `clean-docs` pack instance for pack run
`pack-13915-pipeline-ship-1.39.15` (issue #1290, release `1.39.15`) SHALL add a
JSON fixture at exactly
`core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json`. That
fixture SHALL declare a `release_version` field whose value is the string
`1.39.15`. A hermetic unit test SHALL read only that run-scoped path and SHALL
fail when `release_version` is not `1.39.15`. The fixture and test SHALL NOT
read or write a fixture directory other than that pack-run path. The instance
SHALL NOT change production behavior, FRG scoring, release preflight, evidence
schema, thresholds, or pack driver pass/fail logic.

#### Scenario: Fixture exists at the pack-run path with release 1.39.15

- **WHEN** the `clean-docs` pack instance for pack run
  `pack-13915-pipeline-ship-1.39.15` is implemented
- **THEN** the repository tree SHALL contain
  `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json`
- **AND** that file SHALL declare `release_version` equal to the string
  `1.39.15`

#### Scenario: Unit test fails when the fixture version changes

- **WHEN** a unit test loads
  `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json`
- **AND** the fixture `release_version` is not the string `1.39.15`
- **THEN** that test SHALL fail
- **AND** the test SHALL NOT call real network, git, or subprocess APIs

#### Scenario: Fixture and test stay inside the run-scoped path

- **WHEN** the fixture file and the pinning test are inspected
- **THEN** both SHALL refer only to
  `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/`
- **AND** they SHALL NOT depend on another pack-run fixture directory

#### Scenario: Production behavior stays unchanged

- **WHEN** the implementation diff for this pack instance is inspected
- **THEN** the diff SHALL NOT modify FRG scoring, factory-gate driver
  pass/fail logic, release preflight, or other production scripts
- **AND** the landed work SHALL be the run-scoped fixture, the pinning test,
  and this OpenSpec change

### Requirement: The clean-docs pack instance for pack-13915-pipeline-ship-1.39.15 SHALL be eligible for ready-to-deploy as clean throughput

The `clean-docs` pack instance for pack run `pack-13915-pipeline-ship-1.39.15`
SHALL be scoped so a correct implementation can reach label
`pipeline:ready-to-deploy` without an engine-class block. The pack-scored
outcome for this item SHALL be clean ready-to-deploy throughput, not a product
behavior change. This instance SHALL NOT add a merge path. Existing FRG
post-pass disposition MAY close the pull request and linked issue without merge
after it records the run.

#### Scenario: Item reaches ready-to-deploy as clean throughput

- **WHEN** the `clean-docs` pack instance PR has a valid OpenSpec change, the
  run-scoped fixture and pinning test, and green `npm run ci`
- **AND** no engine-class defect blocks the run
- **THEN** the issue SHALL be able to receive `pipeline:ready-to-deploy`

#### Scenario: FRG may close the item without merge after it records the run

- **WHEN** FRG records this pack item as scored ready-clean with an open PR
- **THEN** the existing FRG post-pass disposition MAY close the PR and linked
  issue without merge
- **AND** this pack instance's implementation SHALL NOT add a merge path
