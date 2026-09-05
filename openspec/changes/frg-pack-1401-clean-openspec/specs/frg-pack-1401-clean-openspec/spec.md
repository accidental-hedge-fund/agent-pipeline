## Purpose

Pins the pack-1401-pipeline-ship-1.40.1 clean-openspec JSON fixture and its
version-checking unit test so one Factory Reliability Gate item can complete a
clean OpenSpec Pipeline path without production behavior change.

## ADDED Requirements

### Requirement: The pack-1401 clean-openspec fixture SHALL name release 1.40.1 at the run-scoped path

The pack-1401 clean-openspec fixture SHALL exist at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`,
SHALL parse as JSON, and SHALL set `release_version` to the exact string
`1.40.1`. The fixture and test SHALL NOT read or write another pack-run
directory under `core/test/fixtures/frg/`.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
  is parsed as JSON
- **THEN** the object SHALL contain `release_version` with the exact value
  `1.40.1`

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the unit test that verifies this fixture is inspected
- **THEN** it SHALL load
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** it SHALL NOT load a fixture from any other `core/test/fixtures/frg/`
  pack-run directory

---

### Requirement: The unit test SHALL fail when the fixture release version is not 1.40.1

The unit test suite SHALL include a test that reads
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
and asserts that `release_version` equals `1.40.1`. When that field is
missing or holds any other value, the test SHALL fail. The test SHALL read
only that run-scoped path.

#### Scenario: Matching release version passes

- **WHEN** the unit test reads
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** the fixture `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Changed release version fails

- **WHEN** the unit test reads
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** `release_version` is missing or is not `1.40.1`
- **THEN** that test SHALL fail

---

### Requirement: Production pipeline behavior SHALL remain unchanged

This change SHALL add only the run-scoped fixture, its unit test, and the
OpenSpec artifacts for issue #1457. It SHALL NOT change production runtime,
CLI, stages, config, or hosts. It SHALL NOT recreate `plugin/`.

#### Scenario: No production engine files change

- **WHEN** the implementation for this requirement is complete
- **THEN** files under `core/scripts/` and `hosts/` SHALL be unchanged
  relative to the issue's base
- **AND** `plugin/` SHALL remain absent
- **AND** `scripts/build.mjs --check` SHALL pass without a host SKILL
  regeneration caused by this change
