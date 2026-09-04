## Purpose

Pins the run-scoped `clean-openspec` JSON fixture for FRG pack `pack-1401-pipeline-ship-1.40.1` to release `1.40.1` and requires a unit test that fails if that value changes.

## ADDED Requirements

### Requirement: The pack-1401-pipeline-ship-1.40.1 clean-openspec fixture SHALL name release 1.40.1

The JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` SHALL set field `release_version` to the string `1.40.1`. The fixture SHALL be valid JSON. The fixture SHALL NOT name a different release version.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the file `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` is parsed as JSON
- **THEN** the parsed object SHALL contain `release_version` with value `1.40.1`

#### Scenario: Fixture is valid JSON

- **WHEN** a JSON parser reads `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **THEN** parsing SHALL succeed
- **AND** the result SHALL be a JSON object

### Requirement: A unit test SHALL fail if the fixture release_version is not 1.40.1

A co-located unit test SHALL read only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` and SHALL assert that `release_version` equals `1.40.1`. The test SHALL fail when that field is missing, is not a string, or has any other value. The test SHALL perform no live GitHub, git, or subprocess calls.

#### Scenario: Matching release_version passes

- **WHEN** the unit test reads the run-scoped fixture
- **AND** `release_version` is `1.40.1`
- **THEN** the test SHALL pass

#### Scenario: Wrong or missing release_version fails

- **WHEN** the unit test reads the run-scoped fixture
- **AND** `release_version` is absent, is not a string, or is not `1.40.1`
- **THEN** the test SHALL fail

### Requirement: The fixture and test SHALL stay on the run-scoped path and SHALL NOT change production behavior

The fixture and its unit test SHALL use only the run-scoped path under `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/`. They SHALL NOT read or write another pack-run directory under `core/test/fixtures/frg/`. Production pipeline, FRG scoring, merge, and ship behavior SHALL remain unchanged.

#### Scenario: Test uses only the run-scoped fixture path

- **WHEN** the unit test loads fixture data
- **THEN** the loaded path SHALL be `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
- **AND** the test SHALL NOT load a fixture from a different `pack_run_id` directory

#### Scenario: Production modules stay unchanged

- **WHEN** this change is implemented
- **THEN** files under `core/scripts/` SHALL be unmodified
- **AND** merge-inside-advance and merge-inside-loop behavior SHALL remain forbidden
