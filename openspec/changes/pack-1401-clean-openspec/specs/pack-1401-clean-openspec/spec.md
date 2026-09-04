## Purpose

Binds the factory-gate-v1 clean-openspec fixture for pack run
`pack-1401-pipeline-ship-1.40.1` to release `1.40.1` without changing
production pipeline behavior.

## ADDED Requirements

### Requirement: The pack-1401 clean-openspec fixture SHALL name release 1.40.1

The pack-1401 clean-openspec fixture SHALL exist at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`,
SHALL parse as JSON, and SHALL set `release_version` to the exact string
`1.40.1`. The fixture path SHALL be run-scoped to pack run
`pack-1401-pipeline-ship-1.40.1`. The fixture SHALL NOT live under a
different pack-run directory.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
  is parsed as JSON
- **THEN** parsing SHALL succeed
- **AND** the object SHALL contain `release_version` with the exact value
  `1.40.1`

#### Scenario: Fixture is not taken from another pack-run directory

- **WHEN** the clean-openspec fixture for pack run
  `pack-1401-pipeline-ship-1.40.1` is located
- **THEN** its path SHALL be
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** the repository SHALL NOT satisfy this requirement with a fixture
  under a different `pack_run_id` directory

### Requirement: A unit test SHALL fail when the fixture release_version is not 1.40.1

A unit test under `core/test/` SHALL read the fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
and SHALL assert that `release_version` equals `1.40.1`. The test SHALL
fail when that field is missing or has any other value. The test SHALL use
only that run-scoped path. The test SHALL NOT call the network, git, or a
subprocess.

#### Scenario: Matching release_version passes

- **WHEN** the unit test reads
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Changed or missing release_version fails

- **WHEN** the same unit test reads that fixture
- **AND** `release_version` is missing or is not `1.40.1`
- **THEN** the test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the unit test that verifies this fixture is inspected
- **THEN** it SHALL load
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** it SHALL NOT load a fixture from any other
  `core/test/fixtures/frg/` pack-run directory

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL add only the run-scoped fixture, its unit test, and the
OpenSpec artifacts for issue #1425. It SHALL NOT change production runtime,
CLI, stages, config, or hosts. It SHALL NOT recreate `plugin/`.

#### Scenario: No production engine files change

- **WHEN** the implementation for this requirement is complete
- **THEN** files under `core/scripts/` and `hosts/` SHALL be unchanged
  relative to the issue's base
- **AND** `plugin/` SHALL remain absent
- **AND** `scripts/build.mjs --check` SHALL pass without a host SKILL
  regeneration caused by this change
