## MODIFIED Requirements

### Requirement: A versioned experiment manifest SHALL define the experiment

The runner SHALL accept a versioned, repo-local experiment manifest declaring: `schema_version`;
a stable `experiment_id`; the set of `fixture_ids` under test; an execution `mode` that is either
a single named stage, `end-to-end`, `implementing-paired`, or `pipeline-paired`; treatments in
exactly one of two forms — Cartesian treatment axes (`harness`, `provider`, `model`, `effort`,
and other supported axes) **or** a named ordered-pair list (see eval-paired-treatments) — never
both; a `replicates` count; a randomization `seed`; a `concurrency` bound; a per-cell
`timeout`; an `output_dir`; and the execution sandbox mode its cells run under. The sandbox mode
SHALL be optional with a default that preserves the harness's own managed sandbox, so an existing
manifest that omits it stays valid and unchanged in behavior.

Manifest validation SHALL occur before any treatment is executed. A manifest that omits a
required field, names an unknown execution mode, names an unsupported sandbox mode, references an
unknown fixture, declares an unsupported `schema_version`, mixes Cartesian and named-pair
treatment forms, declares a paired mode without named pairs, or declares named pairs without a
paired mode SHALL be rejected with a message naming the offending field, and no treatment SHALL
be executed.

#### Scenario: Complete Cartesian manifest is accepted

- **WHEN** a manifest declaring `schema_version`, `experiment_id`, `fixture_ids`, a non-paired
  `mode`, Cartesian treatment axes, `replicates`, `seed`, `concurrency`, `timeout`, and
  `output_dir` is loaded
- **THEN** the manifest SHALL be accepted as valid

#### Scenario: Complete named-pair paired-mode manifest is accepted

- **WHEN** a manifest declaring `mode` of `implementing-paired` or `pipeline-paired` and a
  named-pair treatments form with at least one valid pair is loaded
- **THEN** the manifest SHALL be accepted as valid

#### Scenario: Manifest with a missing required field is rejected

- **WHEN** a manifest omits a required field
- **THEN** loading SHALL fail with a message naming the missing field
- **AND** no treatment SHALL be executed

#### Scenario: Manifest naming an unknown mode or fixture is rejected

- **WHEN** a manifest declares an execution mode that is not a supported stage name,
  `end-to-end`, `implementing-paired`, or `pipeline-paired`, or references a `fixture_id` that
  does not resolve to a fixture
- **THEN** loading SHALL fail naming the unknown value
- **AND** no treatment SHALL be executed

#### Scenario: Mixed Cartesian and named-pair treatments are rejected

- **WHEN** a manifest's `treatments` field combines Cartesian axis arrays with a named-pair list
- **THEN** loading SHALL fail naming the `treatments` field
- **AND** no treatment SHALL be executed

#### Scenario: Paired mode without named pairs is rejected

- **WHEN** a manifest declares `mode` of `implementing-paired` or `pipeline-paired` with
  Cartesian treatment axes only
- **THEN** loading SHALL fail naming the mismatch
- **AND** no treatment SHALL be executed

#### Scenario: Named pairs without a paired mode are rejected

- **WHEN** a manifest declares named-pair treatments with `mode` of a single stage or
  `end-to-end`
- **THEN** loading SHALL fail naming the mismatch
- **AND** no treatment SHALL be executed

#### Scenario: Manifest naming an unsupported sandbox mode is rejected

- **WHEN** a manifest declares an execution sandbox mode that is not a supported value
- **THEN** loading SHALL fail naming the offending field
- **AND** no treatment SHALL be executed

#### Scenario: Manifest omitting the sandbox mode keeps the managed-sandbox default

- **WHEN** a manifest declares no execution sandbox mode
- **THEN** it SHALL be accepted
- **AND** its cells SHALL run under the harness's own managed sandbox

---

### Requirement: The runner SHALL expand the treatment matrix deterministically and persist the run plan before executing any treatment

The runner SHALL expand the manifest into an explicit run plan. For Cartesian treatments, cells
SHALL be the Cartesian product of fixtures, treatments, and replicates. For named-pair
treatments, cells SHALL be the product of fixtures, declared pairs, and replicates — not a
Cartesian cross of per-role model names across pairs. Each cell SHALL carry a deterministic
`cell_id` derived from its experiment, fixture, treatment, and replicate coordinates. For a
named pair, the cell's `treatment_id` SHALL be the pair's declared `id` and the cell SHALL
preserve the exact primary and reviewer role coordinates.

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

#### Scenario: Named-pair plan preserves ordered pair coordinates

- **WHEN** a named-pair manifest is expanded
- **THEN** each cell SHALL carry the pair `id` as `treatment_id`
- **AND** SHALL carry the exact primary and reviewer harness, model, and effort coordinates
  declared for that pair

---

### Requirement: The runner SHALL support independent stage execution and end-to-end execution

In stage mode the runner SHALL execute exactly one of `planning`, `plan-review`, `implementing`,
`review`, `fix`, or `shipcheck`, entered from the fixture's frozen stage-entry artifacts, and
SHALL NOT execute any other stage. In `end-to-end` mode the runner SHALL execute the normal
pipeline state machine within the isolated evaluation context. In `implementing-paired` and
`pipeline-paired` modes the runner SHALL execute the multi-role pair graphs defined by
eval-paired-treatments, using named-pair treatments and live handoffs rather than single-role
frozen stage entry alone.

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

#### Scenario: Implementing-paired mode runs the pair loop

- **WHEN** an experiment declares `implementing-paired` mode with a valid named-pair treatment
- **THEN** the runner SHALL execute the primary implement → reviewer review → conditional fix →
  re-review graph for each cell
- **AND** SHALL produce one cell record per replicate covering the whole pair loop

#### Scenario: Pipeline-paired mode runs the deployable graph

- **WHEN** an experiment declares `pipeline-paired` mode with a valid named-pair treatment
- **THEN** the runner SHALL execute the planning through adversarial review/fix-2 graph for
  each cell
- **AND** SHALL produce one cell record per replicate covering that graph

## ADDED Requirements

### Requirement: Named-pair treatment validation SHALL reject malformed pair declarations

When the treatments form is named pairs, validation SHALL reject: duplicate pair `id` values;
a pair missing `primary` or `reviewer`; a role coordinate missing required `harness`; and any
unknown field on a pair or role object. Each rejection SHALL name the offending field or pair
id and SHALL prevent any cell from executing.

#### Scenario: Duplicate pair ids are rejected

- **WHEN** two pairs share the same `id`
- **THEN** loading SHALL fail naming the duplicated id
- **AND** no treatment SHALL be executed

#### Scenario: Missing role is rejected

- **WHEN** a pair omits `primary` or omits `reviewer`
- **THEN** loading SHALL fail naming the missing role
- **AND** no treatment SHALL be executed

#### Scenario: Unknown role field is rejected

- **WHEN** a role coordinate includes a field that is not in the allowlisted role fields
- **THEN** loading SHALL fail naming that field
- **AND** no treatment SHALL be executed

#### Scenario: Provider executor and params role fields are rejected until paired execution supports them

- **WHEN** a role coordinate includes `provider`, `executor`, or `params`
- **THEN** loading SHALL fail naming that field
- **AND** no treatment SHALL be executed
