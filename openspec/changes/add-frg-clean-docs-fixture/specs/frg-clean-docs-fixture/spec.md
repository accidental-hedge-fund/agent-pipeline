## Purpose

Defines the release-bound clean-docs fixture evidence used to qualify one Factory Reliability Gate run without altering production behavior.

## ADDED Requirements

### Requirement: Run-scoped release fixture
The repository SHALL contain the clean-docs JSON fixture only at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`, and that fixture SHALL record `release_version` as the string `1.40.1`.

#### Scenario: Fixture identifies the target release
- **WHEN** the run-scoped clean-docs fixture is parsed as JSON
- **THEN** its `release_version` value SHALL equal `1.40.1`

### Requirement: Executable release-version guard
The test suite SHALL read the run-scoped clean-docs fixture and SHALL fail when its `release_version` differs from `1.40.1`.

#### Scenario: Expected release version passes
- **WHEN** the fixture contains `release_version` equal to `1.40.1`
- **THEN** the dedicated fixture test SHALL pass

#### Scenario: Changed release version fails
- **WHEN** the fixture's `release_version` is changed to any value other than `1.40.1`
- **THEN** the dedicated fixture test SHALL fail

### Requirement: Test-only scope
The change SHALL add only the run-scoped fixture, its unit test, and OpenSpec artifacts, and MUST NOT change production behavior.

#### Scenario: Implementation diff is inspected
- **WHEN** the completed implementation is compared with its base
- **THEN** every non-OpenSpec change SHALL be confined to `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and one `core/test/*.test.ts` file

### Requirement: Non-merging FRG completion
The clean-docs item SHALL reach `pipeline:ready-to-deploy` through the full Pipeline, after which the FRG SHALL record the run and close the pull request and issue without merging the pull request.

#### Scenario: Clean-docs item completes
- **WHEN** the full Pipeline successfully processes this item and the FRG records the run
- **THEN** the issue SHALL have reached `pipeline:ready-to-deploy`
- **THEN** the pull request and issue SHALL be closed
- **THEN** the pull request MUST NOT be merged
