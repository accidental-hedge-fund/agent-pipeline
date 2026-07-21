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

