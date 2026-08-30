# frg-pack-13916-clean-docs Specification

## Purpose
Records the Factory Reliability Gate (FRG) `clean-docs` fixture contract for
pack run `pack-13916-pipeline-ship-1.39.16` and release `1.39.16`.

## Requirements

### Requirement: The pack-run clean-docs fixture SHALL name release 1.39.16

The pack-run clean-docs fixture SHALL exist at
`core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-docs.json`,
SHALL parse as JSON, and SHALL set `release_version` to the string `1.39.16`.
The fixture and its unit test SHALL use only that run-scoped path. They SHALL
NOT read or write another pack-run directory under `core/test/fixtures/frg/`.

#### Scenario: Fixture at the run-scoped path names release 1.39.16

- **WHEN** the file
  `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-docs.json`
  is read as JSON
- **THEN** the parsed object SHALL contain `release_version` equal to `1.39.16`

#### Scenario: Missing or wrong release_version fails the unit test

- **WHEN** the unit test reads that run-scoped fixture
- **AND** `release_version` is missing or is not the string `1.39.16`
- **THEN** the unit test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the unit test that verifies this fixture is inspected
- **THEN** it SHALL load
  `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-docs.json`
- **AND** it SHALL NOT load a fixture from any other `core/test/fixtures/frg/`
  pack-run directory

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL add only the run-scoped fixture, its unit test, and the
OpenSpec artifacts for issue #1334. It SHALL NOT change production runtime,
CLI, stages, config, hosts, or the plugin mirror.

#### Scenario: No production engine files change

- **WHEN** the implementation for this requirement is complete
- **THEN** files under `core/scripts/`, `hosts/`, and `plugin/` SHALL be
  unchanged relative to the issue's base
- **AND** `scripts/build.mjs --check` SHALL pass without a plugin regeneration
  caused by this change
