## Purpose

Defines the run-scoped clean-docs fixture and unit-test contract for Factory Reliability Gate
(FRG) pack run `pack-1396-tugboat-ship-1.39.6` at release `1.39.6`, without changing production
behavior.

## ADDED Requirements

### Requirement: Run-scoped clean-docs fixture SHALL name release 1.39.6

The repository SHALL provide a JSON fixture at
`core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json`. That fixture SHALL include
a `release_version` field whose value is the string `1.39.6`. The fixture SHALL NOT live under a
different pack-run directory.

#### Scenario: Fixture exists at the pack-run path with the expected version

- **WHEN** the fixture at `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json` is
  loaded as JSON
- **THEN** parse SHALL succeed
- **AND** the `release_version` field SHALL equal `1.39.6`

#### Scenario: A different pack-run path is out of scope

- **WHEN** a fixture is sought under `core/test/fixtures/frg/` for this pack instance
- **THEN** the only in-scope path SHALL be
  `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json`

---

### Requirement: Unit test SHALL fail when the fixture version changes

A unit test in the core test suite SHALL read
`core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json` and SHALL assert that
`release_version` equals `1.39.6`. The test SHALL fail if that field is missing or has any other
value. The test SHALL NOT read a fixture from another pack-run directory for this assertion.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.39.6`
- **AND** the unit test that reads the run-scoped path runs
- **THEN** that assertion SHALL pass

#### Scenario: Changed or missing version fails

- **WHEN** the fixture `release_version` is absent or is not `1.39.6`
- **AND** the unit test that reads the run-scoped path runs
- **THEN** that test SHALL fail

---

### Requirement: Production pipeline behavior SHALL remain unchanged

This pack instance SHALL add only the run-scoped fixture and its unit test. Production pipeline
code, CLI commands, stage transitions, review policy, and Factory Reliability Gate driver
behavior SHALL remain unchanged.

#### Scenario: No production-path change

- **WHEN** the implementation for this pack instance is inspected
- **THEN** files under `core/scripts/` and host packaging SHALL be unmodified by this change
- **AND** merge, auto-merge, and merge-queue behavior SHALL remain unchanged
