# eval-fixture-contract Specification

## Purpose
TBD - created by archiving change stage-eval-runner. Update Purpose after archive.
## Requirements
### Requirement: A frozen evaluation fixture SHALL declare a complete, self-contained task definition

An evaluation fixture SHALL be a versioned, repo-local record describing one frozen task. Each
fixture SHALL declare: a stable `fixture_id`; a `schema_version`; a `base_commit` (a full,
immutable commit SHA); the task input (the issue or spec text under evaluation); the
stage-entry artifacts required to enter each stage the fixture supports; the public checks that
may be run against a candidate result; references to the graders that apply to it; a task
`category`; a `risk` classification; and a `provenance` value of `synthetic` or `harvested`.

The fixture SHALL be self-contained with respect to execution: entering a supported stage SHALL
require no data beyond the fixture and the repository at `base_commit`.

#### Scenario: A complete fixture is accepted

- **WHEN** a fixture declaring `fixture_id`, `schema_version`, `base_commit`, task input,
  stage-entry artifacts, public checks, grader references, `category`, `risk`, and `provenance`
  is loaded
- **THEN** the fixture SHALL be accepted as valid
- **AND** its `base_commit` SHALL be exposed to the runner as the checkout point for every cell
  derived from it

#### Scenario: Fixture provenance distinguishes synthetic from harvested tasks

- **WHEN** a fixture's `provenance` field is read
- **THEN** it SHALL be exactly one of `synthetic` or `harvested`
- **AND** a downstream consumer SHALL be able to partition fixtures into those two populations
  using that field alone

#### Scenario: Stage-entry artifacts allow a stage to be entered directly

- **WHEN** a fixture declares stage-entry artifacts for a stage such as `review` or `fix`
- **THEN** those artifacts SHALL supply the frozen inputs that stage would otherwise have
  received from its predecessor stage
- **AND** entering that stage SHALL require no artifact produced by a live predecessor run

---

### Requirement: Fixture validation SHALL reject an incomplete or ambiguous fixture before execution

Fixture loading SHALL validate every fixture referenced by an experiment before any treatment is
executed. A fixture SHALL be rejected when a required field is missing, when `base_commit` is not
a full commit SHA, when `provenance` is not one of the permitted values, when the fixture declares
no stage-entry artifacts for the stage the experiment targets, or when its `schema_version` is
unsupported. A rejection SHALL name the fixture and the offending field, and SHALL prevent the
experiment from executing rather than producing a degraded cell.

#### Scenario: Missing required field is rejected by name

- **WHEN** a fixture omits a required field
- **THEN** validation SHALL fail with a message naming the fixture and the missing field
- **AND** no treatment SHALL be executed for that experiment

#### Scenario: Abbreviated or mutable base commit is rejected

- **WHEN** a fixture's `base_commit` is a branch name, a tag, or an abbreviated SHA
- **THEN** validation SHALL fail
- **AND** the failure message SHALL state that a full immutable commit SHA is required

#### Scenario: Fixture that cannot enter the targeted stage is rejected

- **WHEN** an experiment targets a stage for which a referenced fixture declares no stage-entry
  artifacts
- **THEN** validation SHALL fail naming that fixture and that stage
- **AND** the runner SHALL NOT execute the experiment with the fixture silently skipped

#### Scenario: Unsupported schema version is rejected

- **WHEN** a fixture declares a `schema_version` the loader does not support
- **THEN** validation SHALL fail naming the fixture and the unsupported version
- **AND** the loader SHALL NOT attempt a best-effort interpretation of the fixture

### Requirement: A fixture SHALL be able to declare hidden checks that are never exposed to a treatment

The fixture contract SHALL admit an optional set of **hidden checks** — deterministic checks
resolvable only by the grading layer. Hidden checks SHALL NOT appear in any input, artifact, or prompt supplied to a treatment, and SHALL
be disjoint from the fixture's public checks. A fixture that declares the same check as both public
and hidden SHALL be rejected, naming the fixture and the offending check.

A fixture that declares no hidden checks SHALL remain valid.

#### Scenario: Hidden checks are absent from treatment inputs

- **WHEN** a cell is executed for a fixture declaring hidden checks
- **THEN** no input, stage-entry artifact, or materialized prompt supplied to the treatment SHALL
  contain any hidden check

#### Scenario: A check declared both public and hidden is rejected

- **WHEN** a fixture declares the same check in both its public checks and its hidden checks
- **THEN** fixture validation SHALL fail naming the fixture and that check

#### Scenario: Hidden checks are optional

- **WHEN** a fixture declaring no hidden checks is loaded
- **THEN** validation SHALL succeed

---

### Requirement: A review fixture SHALL be able to declare seeded-defect ground truth

The fixture contract SHALL admit an optional set of **seeded defects** serving as ground truth for
review grading. Each seeded defect SHALL declare a stable `defect_id` unique within the fixture, a location consisting of a repository
path and a line range, and an `expected_severity`. A fixture declaring a seeded defect with a
duplicate `defect_id`, a missing location, or a missing `expected_severity` SHALL be rejected naming
the fixture and the offending defect.

#### Scenario: A complete seeded defect is accepted

- **WHEN** a fixture declares a seeded defect with a unique `defect_id`, a path and line range, and
  an `expected_severity`
- **THEN** validation SHALL succeed
- **AND** the defect SHALL be exposed to the grading layer as review ground truth

#### Scenario: A duplicate defect identifier is rejected

- **WHEN** a fixture declares two seeded defects with the same `defect_id`
- **THEN** validation SHALL fail naming the fixture and the duplicated `defect_id`

#### Scenario: An incomplete seeded defect is rejected

- **WHEN** a seeded defect omits its location or its `expected_severity`
- **THEN** validation SHALL fail naming the fixture, the `defect_id`, and the missing field

---

### Requirement: A fixture SHALL be able to declare acceptance criteria and an allowed-change boundary

The fixture contract SHALL admit optional **acceptance criteria** — individually identified,
checkable statements a correct result must satisfy — and an optional **allowed-change boundary**
listing the repository paths a correct result may modify. When an allowed-change boundary is declared, the
grading layer SHALL treat every changed path outside it as out of scope; when none is declared, the
out-of-scope measurement SHALL be reported as unknown rather than as zero.

#### Scenario: Acceptance criteria are exposed to grading

- **WHEN** a fixture declaring acceptance criteria is loaded
- **THEN** each criterion SHALL carry a stable identifier
- **AND** the criteria SHALL be exposed to the grading layer

#### Scenario: An allowed-change boundary defines out-of-scope changes

- **WHEN** a fixture declares an allowed-change boundary
- **THEN** the grading layer SHALL classify a changed path not covered by that boundary as an
  out-of-scope change

#### Scenario: Absent boundary yields unknown rather than zero

- **WHEN** a fixture declares no allowed-change boundary
- **THEN** the out-of-scope change measurement for cells of that fixture SHALL be reported as
  unknown
- **AND** SHALL NOT be reported as zero

---

### Requirement: A fixture SHALL declare version identifiers for the graders that apply to it

A fixture's grader references SHALL carry a version identifier for each referenced grader, so that a
grade can state which grader version produced it. A fixture referencing a grader whose version the
grading layer does not support SHALL be rejected naming the fixture, the grader, and the unsupported
version, rather than being graded on a best-effort basis.

#### Scenario: Grader references carry versions

- **WHEN** a fixture's grader references are read
- **THEN** each reference SHALL name a grader and a grader version

#### Scenario: An unsupported grader version is rejected

- **WHEN** a fixture references a grader version the grading layer does not support
- **THEN** validation SHALL fail naming the fixture, the grader, and the unsupported version
- **AND** the grading layer SHALL NOT grade that fixture's cells on a best-effort basis

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

