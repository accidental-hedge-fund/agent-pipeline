## Purpose

Pins the pack-1401-pipeline-ship-1.40.1 clean-docs JSON fixture and its version-checking unit test so one Factory Reliability Gate item can complete a clean Pipeline path without production behavior change.

## ADDED Requirements

### Requirement: The pack-1401 clean-docs fixture SHALL name release 1.40.1 at the run-scoped path

The repository SHALL provide a JSON fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. That fixture SHALL contain
a `release_version` field whose value is the string `1.40.1`. The fixture SHALL use only that
run-scoped path.

#### Scenario: Fixture exists at the pack-run path with release 1.40.1

- **WHEN** the repository tree is inspected for the pack-1401 clean-docs fixture
- **THEN** file `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` SHALL exist
- **AND** parsing it as JSON SHALL succeed
- **AND** its `release_version` value SHALL equal `1.40.1`

#### Scenario: A different pack-run path is not the fixture location

- **WHEN** a caller looks for the pack-1401 clean-docs fixture under any path other than
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **THEN** that other path SHALL NOT be the contract location for this pack run

---

### Requirement: The unit test SHALL fail when the fixture release version is not 1.40.1

The unit test suite SHALL include a test that reads
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and asserts that
`release_version` equals `1.40.1`. When that field holds any other value, the test SHALL fail.
The test SHALL read only that run-scoped path.

#### Scenario: Matching release version passes

- **WHEN** the unit test reads `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** the fixture `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Changed release version fails

- **WHEN** the unit test reads `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** the fixture `release_version` is not `1.40.1`
- **THEN** the test SHALL fail

---

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL NOT alter production pipeline CLI, stage, Factory Reliability Gate driver,
merge, or host-skill behavior. The added run-scoped fixture and its unit test SHALL be the only
runtime artifacts this change introduces.

#### Scenario: Production surfaces stay unmodified

- **WHEN** the change is compared against production code under `core/scripts/`, host skills, and
  merge or release commands
- **THEN** those surfaces SHALL have no behavior change attributable to this pack item
