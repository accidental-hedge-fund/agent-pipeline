## Purpose

Defines the run-scoped clean-docs JSON fixture and unit-test contract used by
Factory Reliability Gate pack run `frg-1-33-0-d5d716355f2ed48d04aa8dde` to exercise
one clean Pipeline path without changing production behavior.

## ADDED Requirements

### Requirement: Run-scoped clean-docs fixture SHALL pin release 1.33.0

The repository SHALL provide a JSON fixture at exactly
`core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`.
That fixture SHALL include a `release_version` field whose value is the string
`1.33.0`. The fixture path SHALL be scoped to pack run id
`frg-1-33-0-d5d716355f2ed48d04aa8dde` and SHALL NOT live under a shared or
other pack-run directory for this item.

#### Scenario: Fixture exists at the pack-run path with pinned version

- **WHEN** the clean-docs fixture for pack run
  `frg-1-33-0-d5d716355f2ed48d04aa8dde` is loaded from
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`
- **THEN** the fixture JSON SHALL parse successfully
- **AND** its `release_version` field SHALL equal `1.33.0`

#### Scenario: Fixture is not placed on a non-run-scoped path

- **WHEN** the clean-docs fixture for this pack run is inspected in the tree
- **THEN** it SHALL reside under
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/`
- **AND** this item SHALL NOT introduce a substitute fixture only under a
  shared path such as `core/test/fixtures/frg/clean-docs.json`

### Requirement: Unit test SHALL assert the run-scoped fixture version

A unit test SHALL read the clean-docs fixture only from
`core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`
and SHALL assert that `release_version` equals `1.33.0`. The test SHALL fail
when that field is missing or has any other value. The test SHALL NOT change
production pipeline behavior.

#### Scenario: Matching release_version passes

- **WHEN** the unit test loads the run-scoped clean-docs fixture whose
  `release_version` is `1.33.0`
- **THEN** the assertion on `release_version` SHALL pass

#### Scenario: Changed release_version fails the test

- **WHEN** the fixture's `release_version` is changed to a value other than
  `1.33.0` (or the field is removed)
- **AND** the unit test is run
- **THEN** the test SHALL fail

#### Scenario: Production behavior remains unchanged

- **WHEN** this clean-docs fixture and unit test are added
- **THEN** no production stage, configuration, or runtime path SHALL be
  required to change for the item to satisfy this capability
