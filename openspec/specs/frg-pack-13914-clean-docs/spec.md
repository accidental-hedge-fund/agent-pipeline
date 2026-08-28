# frg-pack-13914-clean-docs Specification

## Purpose
Pins the Factory Reliability Gate (FRG) `clean-docs` instance for pack run
`pack-13914-pipeline-ship-1.39.14` to a run-scoped JSON fixture and a unit test
that assert release `1.39.14`, without changing production pipeline behavior.

## Requirements

### Requirement: The run-scoped clean-docs fixture SHALL name release 1.39.14

The repository SHALL contain a JSON fixture at
`core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json`.
That fixture SHALL include a `release_version` field whose value is exactly
`1.39.14`.

#### Scenario: Fixture exists at the pack-run path

- **WHEN** the test suite loads
  `core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json`
- **THEN** the file SHALL exist
- **AND** the file SHALL parse as JSON
- **AND** the parsed object SHALL have `release_version` equal to `1.39.14`

#### Scenario: Fixture does not live under another pack-run directory

- **WHEN** the fixture path is inspected
- **THEN** the path SHALL include directory segment `pack-13914-pipeline-ship-1.39.14`
- **AND** the path SHALL NOT use a different pack-run id

### Requirement: A unit test SHALL fail when the fixture release_version changes

A unit test SHALL read the run-scoped fixture and assert that
`release_version` is `1.39.14`. The test SHALL fail if that field is missing,
empty, or any other string. The test SHALL perform no real network, git, or
subprocess calls.

#### Scenario: Matching version passes

- **WHEN** the unit test reads the fixture and `release_version` is `1.39.14`
- **THEN** the test SHALL pass

#### Scenario: Changed version fails

- **WHEN** the unit test reads the fixture and `release_version` is not `1.39.14`
- **THEN** the test SHALL fail

### Requirement: Production pipeline behavior SHALL stay unchanged

This change SHALL NOT alter production stage logic, CLI commands, review
policy, FRG driver scoring, ship coordinator, merge commands, or GitHub write
helpers. Advance, single, and loop SHALL continue to stop at
`pipeline:ready-to-deploy` and SHALL NOT merge.

#### Scenario: Production scripts are not required to change

- **WHEN** the change is implemented
- **THEN** production modules under `core/scripts/` SHALL keep their existing
  behavior
- **AND** no `auto_merge` config key or merge stage SHALL be added
