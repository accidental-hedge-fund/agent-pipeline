## ADDED Requirements

### Requirement: A fixture SHALL declare an environment-fidelity contract for each external dependency

A fixture SHALL be able to declare an **environment-fidelity contract**: an optional list of the
external tools, services, or data dependencies the task may touch. Each declared dependency SHALL
carry a `mode` of exactly one of `live`, `simulated`, or `forbidden`, a versioned mode identifier so
a simulation or mode change is detectable, its required permissions, its deterministic initial
state, its expected outputs/errors, and deterministic setup and teardown behavior. Fixture
validation SHALL reject a dependency whose `mode` is not one of the permitted values, or that omits
a required field, naming the fixture and the offending dependency and field. A fixture that declares
no external dependencies SHALL remain valid.

#### Scenario: A complete dependency declaration is accepted

- **WHEN** a fixture declares an external dependency with a `mode` of `live`, `simulated`, or
  `forbidden`, a mode version, required permissions, an initial state, expected outputs/errors, and
  deterministic setup/teardown
- **THEN** validation SHALL accept the dependency
- **AND** its declared `mode` SHALL be exposed to the runner and grading layers

#### Scenario: An unknown dependency mode is rejected by name

- **WHEN** a fixture declares an external dependency whose `mode` is not `live`, `simulated`, or
  `forbidden`
- **THEN** validation SHALL fail naming the fixture and the offending dependency
- **AND** no treatment SHALL be executed for an experiment referencing that fixture

#### Scenario: An incomplete dependency is rejected by name

- **WHEN** a fixture declares an external dependency that omits a required field
- **THEN** validation SHALL fail naming the fixture, the dependency, and the missing field

#### Scenario: A fixture with no external dependencies stays valid

- **WHEN** a fixture declares no environment-fidelity dependencies
- **THEN** validation SHALL succeed

### Requirement: A live external dependency SHALL require explicit maintainer selection and SHALL NOT be the default

The environment-fidelity contract SHALL default a newly declared dependency to `simulated` (when a
deterministic stand-in is possible) or `forbidden`, and SHALL NOT propose `live` as a default. A
dependency mode of `live` for a dependency that can incur cost, mutate external state, or access
production data SHALL require an explicit maintainer selection; the workflow SHALL surface that risk
and SHALL NOT promote a draft whose dependency silently defaulted to `live`.

#### Scenario: The default proposed mode is never live

- **WHEN** a newly declared external dependency is proposed for a fixture draft
- **THEN** its default `mode` SHALL be `simulated` or `forbidden`
- **AND** it SHALL NOT default to `live`

#### Scenario: A cost- or mutation-bearing live dependency requires explicit selection

- **WHEN** a dependency that can incur cost, mutate external state, or access production data is set
  to `mode: live`
- **THEN** the change SHALL require an explicit maintainer selection recording that choice
- **AND** a draft whose dependency was not explicitly selected as `live` SHALL NOT be promoted with
  that dependency live

### Requirement: A fixture SHALL expose an environment-and-surface provenance hash

A fixture SHALL expose an **environment-and-surface provenance hash** derived from its resolved
environment-fidelity contract together with its resolved capability-surface inventory (the stage,
materialized prompts, harness/model configuration, tools/hooks, repository paths, and referenced
services/data dependencies). Two fixtures whose resolved environment contract and resolved surface
are identical SHALL produce an identical hash; two that differ only in a dependency mode or in the
resolved surface SHALL produce different hashes.

#### Scenario: Identical environment and surface hash identically

- **WHEN** two fixtures have an identical resolved environment-fidelity contract and an identical
  resolved capability surface
- **THEN** their environment-and-surface provenance hashes SHALL be equal

#### Scenario: A single mode change changes the hash

- **WHEN** two fixtures are identical except that one dependency's `mode` differs (for example
  `simulated` versus `live`)
- **THEN** their environment-and-surface provenance hashes SHALL differ
