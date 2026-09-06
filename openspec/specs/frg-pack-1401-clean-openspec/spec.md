# frg-pack-1401-clean-openspec Specification

## Purpose
Defines the run-scoped fixture contract exercised by the synthetic
Factory Reliability Gate OpenSpec path for release 1.40.1.

## Requirements

### Requirement: Pack-1401 clean-openspec fixture SHALL name release 1.40.1

The fixture SHALL name release `1.40.1`. The JSON fixture at
`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
sets `release_version` to that string. Its unit test SHALL read
only that run-scoped path and production pipeline behavior SHALL remain
unchanged.

#### Scenario: Fixture names release 1.40.1

- **WHEN** the run-scoped fixture is parsed as JSON
- **THEN** its `release_version` field SHALL equal `1.40.1`

#### Scenario: Wrong version fails the unit test

- **WHEN** the fixture's `release_version` differs from `1.40.1`
- **THEN** the unit test SHALL fail

#### Scenario: Test remains run-scoped

- **WHEN** the unit test loads the clean-openspec fixture
- **THEN** it SHALL NOT read any other pack-run directory
