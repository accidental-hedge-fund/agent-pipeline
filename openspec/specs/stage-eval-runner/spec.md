# stage-eval-runner Specification

## Purpose
TBD - created by archiving change stage-eval-runner. Update Purpose after archive.
## Requirements
### Requirement: A versioned experiment manifest SHALL define the experiment

The runner SHALL accept a versioned, repo-local experiment manifest declaring: `schema_version`;
a stable `experiment_id`; the set of `fixture_ids` under test; an execution `mode` that is either
a single named stage or `end-to-end`; the treatment axes (`harness`, `provider`, `model`,
`effort`); a `replicates` count; a randomization `seed`; a `concurrency` bound; a per-cell
`timeout`; and an `output_dir`.

Manifest validation SHALL occur before any treatment is executed. A manifest that omits a
required field, names an unknown execution mode, references an unknown fixture, or declares an
unsupported `schema_version` SHALL be rejected with a message naming the offending field, and no
treatment SHALL be executed.

#### Scenario: Complete manifest is accepted

- **WHEN** a manifest declaring `schema_version`, `experiment_id`, `fixture_ids`, `mode`,
  treatment axes, `replicates`, `seed`, `concurrency`, `timeout`, and `output_dir` is loaded
- **THEN** the manifest SHALL be accepted as valid

#### Scenario: Manifest with a missing required field is rejected

- **WHEN** a manifest omits a required field
- **THEN** loading SHALL fail with a message naming the missing field
- **AND** no treatment SHALL be executed

#### Scenario: Manifest naming an unknown mode or fixture is rejected

- **WHEN** a manifest declares an execution mode that is neither a supported stage name nor
  `end-to-end`, or references a `fixture_id` that does not resolve to a fixture
- **THEN** loading SHALL fail naming the unknown value
- **AND** no treatment SHALL be executed

---

### Requirement: The runner SHALL expand the treatment matrix deterministically and persist the run plan before executing any treatment

The runner SHALL expand the manifest into an explicit run plan whose cells are the Cartesian
product of fixtures, treatments, and replicates. Each cell SHALL carry a deterministic
`cell_id` derived from its experiment, fixture, treatment, and replicate coordinates.

The expanded plan SHALL be written to the experiment's output directory **before** the first
treatment is executed. Expansion SHALL be a pure function of the manifest and its referenced
fixtures: expanding the same manifest twice SHALL produce an identical plan. The expansion SHALL
be invocable on its own, without executing any treatment.

#### Scenario: Plan is persisted before the first treatment runs

- **WHEN** an experiment is started
- **THEN** the expanded run plan SHALL be written to the experiment output directory
- **AND** that write SHALL complete before any harness is invoked for any cell

#### Scenario: Expansion is deterministic

- **WHEN** the same manifest and the same referenced fixtures are expanded twice
- **THEN** the two plans SHALL contain the same cells with the same `cell_id` values in the same
  order

#### Scenario: Plan can be produced without executing treatments

- **WHEN** the plan-only entry point is invoked for a manifest
- **THEN** the run plan SHALL be written
- **AND** no harness SHALL be invoked and no worktree SHALL be created

#### Scenario: Cell identity encodes its coordinates

- **WHEN** a cell's `cell_id` is inspected
- **THEN** it SHALL be derived deterministically from the experiment id, fixture id, treatment
  id, and replicate index
- **AND** two runs of the same manifest SHALL produce the same `cell_id` for the same
  coordinates

---

### Requirement: Every cell SHALL execute in a fresh isolated worktree at the fixture base commit

Each cell SHALL execute in a worktree created fresh for that cell and checked out at its
fixture's `base_commit`. No two cells — including replicates of the same treatment — SHALL share
a worktree path, a branch, a session identity, a generated-file location, or an output record.
No cell SHALL observe files, state, or artifacts produced by another cell.

#### Scenario: Each cell gets its own worktree at the fixture base commit

- **WHEN** the runner executes a cell
- **THEN** a worktree SHALL be created for that cell alone and checked out at the fixture's
  `base_commit`
- **AND** the cell's execution working directory SHALL be that worktree

#### Scenario: Replicates of one treatment do not share state

- **WHEN** a treatment is executed with a replicate count greater than one
- **THEN** each replicate SHALL receive a distinct worktree, branch, and session identity
- **AND** no replicate SHALL read or write files produced by another replicate

#### Scenario: Concurrent cells are mutually isolated

- **WHEN** multiple cells execute concurrently under the manifest's `concurrency` bound
- **THEN** each SHALL operate in its own worktree with its own output record
- **AND** no cell's writes SHALL be visible in another cell's worktree

---

### Requirement: The runner SHALL support independent stage execution and end-to-end execution

In stage mode the runner SHALL execute exactly one of `planning`, `plan-review`, `implementing`,
`review`, `fix`, or `shipcheck`, entered from the fixture's frozen stage-entry artifacts, and
SHALL NOT execute any other stage. In `end-to-end` mode the runner SHALL execute the normal
pipeline state machine within the isolated evaluation context.

#### Scenario: A single stage is executed from frozen inputs

- **WHEN** an experiment declares a stage mode of `review`
- **THEN** the runner SHALL invoke the review stage using the fixture's frozen stage-entry
  artifacts
- **AND** SHALL NOT invoke the planning, implementing, fix, or shipcheck stages

#### Scenario: Each supported stage is independently invocable

- **WHEN** an experiment declares any of `planning`, `plan-review`, `implementing`, `review`,
  `fix`, or `shipcheck` as its mode
- **THEN** that stage SHALL be executed directly from the fixture's frozen inputs without first
  executing its predecessor stages

#### Scenario: End-to-end mode runs the state machine in isolation

- **WHEN** an experiment declares `end-to-end` mode
- **THEN** the runner SHALL execute the normal pipeline state machine inside the cell's isolated
  evaluation context
- **AND** SHALL produce one cell record per replicate

---

### Requirement: Evaluation mode SHALL perform no production GitHub writes

While executing an experiment, the runner and every stage it invokes SHALL perform no mutating
GitHub operation against production state. In particular, evaluation mode SHALL NOT set or remove
a label, post or edit a comment, create, edit, or merge a pull request, or push to a production
branch, and SHALL NOT transition any real issue's authoritative pipeline state. This restriction
SHALL be enforced by the evaluation-mode GitHub surface refusing mutating operations, rather than
relying on individual call sites to check a mode flag.

#### Scenario: No mutating GitHub call occurs during an experiment

- **WHEN** a full experiment matrix is executed in either stage mode or end-to-end mode
- **THEN** no label set or removal, no comment creation or edit, no pull-request creation, edit,
  or merge, and no push to a production branch SHALL be performed

#### Scenario: A stage attempting a production write fails loudly

- **WHEN** a stage invoked in evaluation mode attempts a mutating GitHub operation
- **THEN** the evaluation-mode GitHub surface SHALL refuse the operation
- **AND** the cell SHALL record the refusal rather than silently completing as if the write had
  succeeded

#### Scenario: No real issue changes authoritative state

- **WHEN** an experiment references a fixture derived from a real issue
- **THEN** that issue's pipeline stage label and authoritative state SHALL be unchanged after the
  experiment completes

---

### Requirement: Execution order SHALL be seed-randomized, harness-interleaved, and resumable

The runner SHALL derive the execution order of the plan's cells from the manifest `seed`, and
SHALL interleave cells across harnesses rather than executing all cells of one harness
consecutively. The same manifest and seed SHALL reproduce the same execution order.

An interrupted experiment SHALL be resumable: re-invoking the runner for the same experiment
SHALL execute only the cells that have no completed record, SHALL NOT re-execute a completed
cell, and SHALL NOT modify or rewrite any previously written record.

#### Scenario: Order is reproducible from the seed

- **WHEN** the same manifest with the same seed is scheduled twice
- **THEN** the resulting execution order SHALL be identical

#### Scenario: Harnesses are interleaved rather than batched

- **WHEN** a plan contains cells for more than one harness
- **THEN** the execution order SHALL interleave the harnesses
- **AND** SHALL NOT execute every cell of one harness before beginning another harness

#### Scenario: Resume skips completed cells

- **WHEN** an experiment is interrupted after some cells have completed and is then re-invoked
- **THEN** only the cells without a completed record SHALL be executed
- **AND** the previously written records SHALL remain byte-identical

---

### Requirement: Cell outcomes SHALL be classified into distinct result classes

Every executed cell SHALL record a `result_class` of exactly one of `completed`, `infra_error`,
`auth_error`, or `timeout`. `completed` SHALL mean the treatment ran and produced an outcome,
including an outcome in which the treatment performed badly. `infra_error` SHALL cover worktree,
git, filesystem, and runner defects. `auth_error` SHALL cover missing or expired credentials and
quota or rate-limit refusals. `timeout` SHALL cover a cell exceeding the manifest's per-cell
timeout. Infrastructure, authentication, and timeout failures SHALL NOT be recorded as treatment
outcomes.

#### Scenario: A poor treatment outcome is a completed result

- **WHEN** a harness executes and returns an unsuccessful treatment outcome
- **THEN** the cell SHALL be recorded with `result_class` `completed`

#### Scenario: Infrastructure failure is not a treatment outcome

- **WHEN** worktree creation, a git operation, or a filesystem operation fails for a cell
- **THEN** the cell SHALL be recorded with `result_class` `infra_error`
- **AND** SHALL NOT be counted as a treatment outcome

#### Scenario: Authentication or quota failure is distinguished

- **WHEN** a harness invocation fails because credentials are missing or expired, or because a
  quota or rate limit was refused
- **THEN** the cell SHALL be recorded with `result_class` `auth_error`
- **AND** SHALL NOT be counted as a treatment outcome

#### Scenario: Per-cell timeout is distinguished

- **WHEN** a cell exceeds the manifest's per-cell `timeout`
- **THEN** the cell SHALL be terminated and recorded with `result_class` `timeout`
- **AND** SHALL NOT be counted as a treatment outcome

---

### Requirement: Every cell record SHALL carry the identity keys needed to join it to normal run evidence

Every cell record SHALL include `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
`prompt_hash`, `config_hash`, and `base_sha`. `prompt_hash` SHALL be computed over the
materialized prompt text used for that cell and `config_hash` over the effective configuration
for that cell, so that a prompt-template or configuration change is detectable as a difference
between populations.

#### Scenario: Identity keys are present on every record

- **WHEN** any cell record is read from the experiment output
- **THEN** it SHALL contain `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
  `prompt_hash`, `config_hash`, and `base_sha`

#### Scenario: Prompt and config changes are visible as hash differences

- **WHEN** two cells are executed with the same fixture and treatment but a different
  materialized prompt or a different effective configuration
- **THEN** their `prompt_hash` or `config_hash` values SHALL differ

#### Scenario: A cell joins to ordinary run evidence

- **WHEN** a cell record and an ordinary pipeline run artifact are compared
- **THEN** the recorded identity keys SHALL be sufficient to determine whether they describe the
  same fixture, treatment, and base commit

---

### Requirement: Experiment results SHALL be written under an additive append-only filesystem contract

The runner SHALL write results under `<output_dir>/<experiment-id>/` containing the resolved
manifest as executed, the expanded run plan, a record stream of completed cells, and a record
stream of failed cells. The two record streams SHALL be append-only newline-delimited JSON:
each line SHALL be an independently parseable JSON object, and an already-written line SHALL
never be rewritten or removed by a later append or by a resumed run.

The runner SHALL write nothing to a production issue's run artifacts, and SHALL NOT alter
pipeline behavior when no experiment is invoked.

#### Scenario: Output layout is created for an experiment

- **WHEN** an experiment executes
- **THEN** `<output_dir>/<experiment-id>/` SHALL contain the resolved manifest, the run plan, a
  completed-cell record stream, and a failed-cell record stream

#### Scenario: Record streams are append-only and line-parseable

- **WHEN** a cell record is written
- **THEN** it SHALL be appended as one independently parseable JSON line
- **AND** previously written lines SHALL be unchanged

#### Scenario: Failures are separated from completed results

- **WHEN** a cell is recorded with `result_class` `infra_error`, `auth_error`, or `timeout`
- **THEN** its record SHALL be written to the failed-cell stream
- **AND** SHALL NOT appear in the completed-cell stream

#### Scenario: No production run artifacts are written

- **WHEN** an experiment executes
- **THEN** no run artifact SHALL be written for any production issue
- **AND** ordinary pipeline behavior SHALL be unchanged when no experiment is invoked

---

### Requirement: Runner behavior SHALL be tested against fake harnesses with no live model calls

The runner SHALL be covered by unit and integration tests that inject their dependencies through
fakes, exercising manifest validation, matrix expansion determinism, scheduling order and
interleaving, per-cell isolation, resume, result classification, and the no-production-writes
guarantee. These tests SHALL
make no live model call and no real network, git, or subprocess call, so the repository's
continuous-integration gate exercises the runner without provider credentials.

#### Scenario: Core behavior is covered by fake-backed tests

- **WHEN** the test suite runs
- **THEN** manifest validation, expansion determinism, scheduling and interleaving, isolation,
  resume, and result classification SHALL each be exercised through injected fakes

#### Scenario: CI makes no live model call

- **WHEN** the continuous-integration gate runs the runner's tests
- **THEN** no live model call, network request, real git operation, or subprocess spawn SHALL
  occur
- **AND** the tests SHALL pass without any provider credential configured

