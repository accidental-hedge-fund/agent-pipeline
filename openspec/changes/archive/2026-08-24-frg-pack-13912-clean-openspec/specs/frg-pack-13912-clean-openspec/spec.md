## Purpose

Defines the run-scoped FRG `clean-openspec` fixture for pack
`pack-13912-tugboat-ship-1.39.12` so the fixture names release `1.39.12` and a
unit test fails if that value changes.

## ADDED Requirements

### Requirement: The pack-13912-tugboat-ship-1.39.12 clean-openspec fixture SHALL name release 1.39.12

The pack-13912-tugboat-ship-1.39.12 clean-openspec fixture SHALL name release 1.39.12. The JSON fixture at `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json` SHALL contain a `release_version` field whose value is the exact string `1.39.12`. A unit test in the `core/test/` suite SHALL read only that run-scoped path and SHALL fail when `release_version` is not `1.39.12`. Production pipeline behavior SHALL remain unchanged.

#### Scenario: Fixture names release 1.39.12

- **WHEN** the file
  `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
  is parsed as JSON
- **THEN** the object SHALL have `release_version` equal to the exact string
  `1.39.12`

#### Scenario: Unit test fails when release_version changes

- **WHEN** a unit test in `core/test/` reads that run-scoped fixture path
- **AND** `release_version` is missing or is any value other than `1.39.12`
- **THEN** the test SHALL fail

#### Scenario: Fixture and test stay on the run-scoped path

- **WHEN** the fixture or the unit test is inspected
- **THEN** the fixture path SHALL be exactly
  `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
- **AND** the test SHALL NOT read a fixture under a different `pack_run_id`
  directory

#### Scenario: Production behavior is unchanged

- **WHEN** this change is implemented
- **THEN** no production module under `core/scripts/` SHALL change
- **AND** runtime pipeline stages SHALL behave as they did before the fixture
  and test were added
