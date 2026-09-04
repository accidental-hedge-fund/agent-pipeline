# frg-pack-1401-clean-docs Specification

## Purpose
TBD - created by archiving change frg-pack-1401-clean-docs. Update Purpose after archive.
## Requirements
### Requirement: The pack-1401 clean-docs fixture SHALL pin release_version 1.40.1

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. That fixture
SHALL parse as JSON. That fixture SHALL include a `release_version` field whose value
is the string `1.40.1`.

#### Scenario: Fixture exists at the run-scoped path

- **WHEN** the repository tree is inspected at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **THEN** that file SHALL exist
- **AND** its contents SHALL parse as JSON

#### Scenario: Fixture release_version is 1.40.1

- **WHEN** the JSON object at that path is read
- **THEN** the `release_version` field SHALL equal the string `1.40.1`

---

### Requirement: A unit test SHALL fail when the pack-1401 clean-docs fixture version changes

The unit test suite SHALL include a test that reads
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and asserts
that `release_version` equals `1.40.1`. That test SHALL fail if the fixture
`release_version` value is not `1.40.1`. That test SHALL use only that run-scoped
path. That test SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Matching fixture version passes

- **WHEN** the unit test reads
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Changed fixture version fails

- **WHEN** the same unit test reads that fixture
- **AND** `release_version` is any value other than `1.40.1`
- **THEN** the test SHALL fail

#### Scenario: Test stays on the run-scoped path

- **WHEN** the unit test locates the fixture
- **THEN** it SHALL read
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** it SHALL NOT read a fixture under a different `pack_run_id` directory

---

### Requirement: The pack-1401 clean-docs path SHALL NOT change production behavior

Implementation of this capability SHALL add only the run-scoped fixture and its unit
test. It SHALL NOT change production CLI, stage, prompt, Factory Reliability Gate
driver, host SKILL, or merge behavior.

#### Scenario: Production modules stay unchanged

- **WHEN** this capability is implemented
- **THEN** files under `core/scripts/` SHALL be unchanged
- **AND** host SKILL sources SHALL be unchanged
- **AND** merge commands and advance/loop merge isolation SHALL be unchanged

