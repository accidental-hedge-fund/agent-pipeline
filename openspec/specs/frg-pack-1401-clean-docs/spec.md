# frg-pack-1401-clean-docs Specification

## Purpose
TBD - created by archiving change frg-pack-1401-clean-docs. Update Purpose after archive.
## Requirements
### Requirement: The pack-1401 clean-docs fixture SHALL name release 1.40.1

The repository SHALL contain a JSON fixture at exactly
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. That fixture SHALL
include a `release_version` field whose value is the string `1.40.1`. The fixture path SHALL
be run-scoped to pack run `pack-1401-pipeline-ship-1.40.1`. The fixture SHALL NOT live under
a different pack-run directory.

#### Scenario: Fixture exists at the run-scoped path with release 1.40.1

- **WHEN** the fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` is read as JSON
- **THEN** parsing SHALL succeed
- **AND** the `release_version` field SHALL equal `1.40.1`

#### Scenario: Fixture is not taken from another pack-run directory

- **WHEN** the clean-docs fixture for pack run `pack-1401-pipeline-ship-1.40.1` is located
- **THEN** its path SHALL be `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** the repository SHALL NOT satisfy this requirement with a fixture under a different `pack_run_id` directory

### Requirement: A unit test SHALL fail when the fixture release_version is not 1.40.1

A unit test under `core/test/` SHALL read the fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and SHALL assert that
`release_version` equals `1.40.1`. The test SHALL fail when that field is missing or has any
other value. The test SHALL use only that run-scoped path. The test SHALL NOT call the
network, git, or a subprocess.

#### Scenario: Matching release_version passes

- **WHEN** the unit test reads `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Changed or missing release_version fails

- **WHEN** the same unit test reads that fixture
- **AND** `release_version` is missing or is not `1.40.1`
- **THEN** the test SHALL fail

### Requirement: Production pipeline behavior SHALL stay unchanged

This capability SHALL add only the run-scoped fixture and its unit test. Pipeline CLI verbs,
stage machines, prompts, host SKILLs, review policy, merge commands, and Factory Reliability
Gate scoring SHALL remain unchanged.

#### Scenario: No production module change is required

- **WHEN** the fixture and unit test are added
- **THEN** no production module under `core/scripts/` SHALL need to change for this capability
- **AND** merge authority SHALL remain operator-authorized loop-isolated commands only

