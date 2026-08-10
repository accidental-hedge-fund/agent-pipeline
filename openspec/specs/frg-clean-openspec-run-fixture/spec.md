# frg-clean-openspec-run-fixture Specification

## Purpose
Defines the run-scoped `clean-openspec` JSON fixture contract for FRG pack run
`frg-1-33-0-d5d716355f2ed48d04aa8dde` so the synthetic item proves OpenSpec hygiene without
changing production pipeline behavior.
## Requirements
### Requirement: Run-scoped clean-openspec fixture SHALL name release 1.33.0

The repository SHALL provide a JSON fixture at the run-scoped path
`core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json`. That fixture
MUST include a top-level `release_version` field whose string value is exactly `1.33.0`. The
fixture and any unit test that asserts this contract SHALL resolve only this run-scoped path
(they SHALL NOT load a shared cross-run fixture path for the same assertion). This requirement
SHALL NOT require any change to production pipeline runtime behavior outside tests and fixtures.

#### Scenario: Fixture file exists and names release 1.33.0

- **WHEN** the file
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json` is read as JSON
- **THEN** the parsed object SHALL have `release_version` equal to the string `1.33.0`

#### Scenario: Unit test verifies the run-scoped fixture only

- **WHEN** the unit test for this contract runs
- **THEN** it SHALL load the fixture exclusively from
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json`
- **AND** it SHALL fail if `release_version` is missing or not exactly `1.33.0`

#### Scenario: Production runtime behavior is unchanged

- **WHEN** this change is implemented
- **THEN** no production stage, CLI command, or FRG driver behavior outside test fixtures SHALL
  be required to change solely to satisfy this fixture contract

