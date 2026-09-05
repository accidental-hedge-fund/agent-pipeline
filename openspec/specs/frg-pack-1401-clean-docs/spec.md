# frg-pack-1401-clean-docs Specification

## Purpose
TBD - created by archiving change frg-pack-1401-clean-docs. Update Purpose after archive.
## Requirements
### Requirement: Run-scoped clean-docs fixture SHALL declare release 1.40.1

The repository SHALL contain a JSON fixture at exactly `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. That fixture SHALL include a `release_version` field whose value is the string `1.40.1`. The fixture SHALL NOT live under a different pack-run directory.

#### Scenario: Fixture exists at the pack-run path

- **WHEN** the repository is inspected at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
- **THEN** the file SHALL exist
- **AND** it SHALL parse as JSON
- **AND** its `release_version` field SHALL equal `1.40.1`

#### Scenario: Fixture is not shared with another pack run

- **WHEN** a caller locates the clean-docs fixture for pack `pack-1401-pipeline-ship-1.40.1`
- **THEN** the path SHALL include the pack-run id `pack-1401-pipeline-ship-1.40.1`
- **AND** the fixture SHALL NOT be read from a sibling directory under `core/test/fixtures/frg/`

### Requirement: Unit test SHALL fail when the fixture version changes

A unit test under `core/test/` SHALL read the run-scoped fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` and SHALL assert that `release_version` equals `1.40.1`. The test SHALL fail when that field is missing or has any other value.

#### Scenario: Matching version passes

- **WHEN** the fixture `release_version` is `1.40.1`
- **THEN** the unit test SHALL pass

#### Scenario: Changed version fails

- **WHEN** the fixture `release_version` is any value other than `1.40.1`
- **THEN** the unit test SHALL fail

### Requirement: Production pipeline behavior SHALL stay unchanged

This change SHALL NOT alter production pipeline modules, CLI verbs, stages, configuration, or host SKILLs. The added fixture and unit test SHALL be the only new behavior.

#### Scenario: No production module change

- **WHEN** the change is applied
- **THEN** files under `core/scripts/` SHALL remain unmodified by this issue
- **AND** no new public CLI verb SHALL be added

