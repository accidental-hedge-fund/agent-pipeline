## Purpose

Records the Factory Reliability Gate (FRG) `clean-docs` fixture contract for
pack run `pack-1401-pipeline-ship-1.40.1` and release `1.40.1`.

## ADDED Requirements

### Requirement: The pack-run clean-docs fixture SHALL name release 1.40.1

The pack-run clean-docs fixture SHALL exist at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`,
SHALL parse as JSON, and SHALL set `release_version` to the string `1.40.1`.
The fixture and its unit test SHALL use only that run-scoped path. They SHALL
NOT read or write another pack-run directory under `core/test/fixtures/frg/`.

#### Scenario: Fixture at the run-scoped path names release 1.40.1

- **WHEN** the file
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
  is read as JSON
- **THEN** the parsed object SHALL contain `release_version` equal to `1.40.1`

#### Scenario: Missing or wrong release_version fails the unit test

- **WHEN** the unit test reads that run-scoped fixture
- **AND** `release_version` is missing or is not the string `1.40.1`
- **THEN** the unit test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the unit test that verifies this fixture is inspected
- **THEN** it SHALL load
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **AND** it SHALL NOT load a fixture from any other `core/test/fixtures/frg/`
  pack-run directory

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL add only the run-scoped fixture, its unit test, and the
OpenSpec artifacts for issue #1464. It SHALL NOT change production runtime,
CLI, stages, config, or hosts. It SHALL NOT recreate `plugin/`.

#### Scenario: No production engine files change

- **WHEN** the implementation for this requirement is complete
- **THEN** files under `core/scripts/` and `hosts/` SHALL be unchanged
  relative to the issue's base
- **AND** `plugin/` SHALL remain absent
- **AND** `scripts/build.mjs --check` SHALL pass without a host SKILL
  regeneration caused by this change
