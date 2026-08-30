# pack-1400-clean-openspec Specification

## Purpose
Binds the factory-gate-v1 clean-openspec fixture for pack run
`pack-1400-pipeline-ship-1.40.0` to release `1.40.0` without changing
production pipeline behavior.

## Requirements

### Requirement: The pack-1400 clean-openspec fixture SHALL name release 1.40.0

The pack-1400 clean-openspec fixture SHALL exist at
`core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`,
SHALL parse as JSON, and SHALL set `release_version` to the exact string
`1.40.0`. A unit test SHALL read only that run-scoped path and SHALL fail
when `release_version` is missing or is not `1.40.0`. The fixture and test
SHALL NOT read or write another pack-run directory under
`core/test/fixtures/frg/`.

#### Scenario: Fixture names release 1.40.0

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`
  is parsed as JSON
- **THEN** the object SHALL contain `release_version` with the exact value
  `1.40.0`

#### Scenario: Unit test fails when the named release changes

- **WHEN** a unit test reads only
  `core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`
- **AND** `release_version` is missing or is not `1.40.0`
- **THEN** that test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the unit test that verifies this fixture is inspected
- **THEN** it SHALL load
  `core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`
- **AND** it SHALL NOT load a fixture from any other `core/test/fixtures/frg/`
  pack-run directory

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL add only the run-scoped fixture, its unit test, and the
OpenSpec artifacts for issue #1343. It SHALL NOT change production runtime,
CLI, stages, config, or hosts. It SHALL NOT recreate `plugin/`.

#### Scenario: No production engine files change

- **WHEN** the implementation for this requirement is complete
- **THEN** files under `core/scripts/` and `hosts/` SHALL be unchanged
  relative to the issue's base
- **AND** `plugin/` SHALL remain absent
- **AND** `scripts/build.mjs --check` SHALL pass without a host SKILL
  regeneration caused by this change
