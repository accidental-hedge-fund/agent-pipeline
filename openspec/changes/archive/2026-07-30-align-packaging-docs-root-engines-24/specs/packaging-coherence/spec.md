## ADDED Requirements

### Requirement: Root and core package versions SHALL match

The repository root `package.json` and `core/package.json` SHALL declare the
same string value in their `version` fields. The packaging coherence gate that
runs as part of `npm run ci` SHALL fail when the two version strings differ.

#### Scenario: Matching versions pass the coherence gate

- **WHEN** root `package.json` and `core/package.json` both declare the same
  `version` string
- **THEN** the packaging coherence gate SHALL pass the version-equality check

#### Scenario: Divergent versions fail the coherence gate

- **WHEN** root `package.json` `version` differs from `core/package.json`
  `version`
- **THEN** the packaging coherence gate SHALL fail
- **AND** the failure output SHALL name both version strings

### Requirement: Root Node engines floor SHALL match the core runtime floor

The repository root `package.json` `engines.node` range SHALL require Node major
version **≥ 24** (or a stricter floor that still excludes majors below 24),
matching the runtime floor declared by `core/package.json` `engines.node` and
enforced by the pipeline launchers. The packaging coherence gate that runs as
part of `npm run ci` SHALL fail when root `engines.node` permits a Node major
below the core’s declared floor.

#### Scenario: Root engines require Node ≥ 24

- **WHEN** the packaging coherence gate evaluates root `package.json`
- **THEN** root `engines.node` SHALL be a range that does not admit Node major
  versions below 24 (e.g. `>=24`)

#### Scenario: Looser root engines fail the coherence gate

- **WHEN** root `engines.node` is `>=18` (or any range that admits Node major
  18–23) while `core/package.json` requires Node ≥ 24
- **THEN** the packaging coherence gate SHALL fail
- **AND** the failure output SHALL identify the engines mismatch

#### Scenario: Packaging coherence is unit-testable without network or git

- **WHEN** the packaging coherence checks run under the scripts test harness
  with fixture package.json contents (or the real repo files under a pure read)
- **THEN** the checks SHALL perform no network, git, or subprocess mutation
- **AND** a deliberate fixture mismatch SHALL fail the corresponding assertion
