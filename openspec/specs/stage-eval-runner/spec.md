# stage-eval-runner Specification

## Purpose
TBD - created by archiving change stage-eval-runner. Update Purpose after archive.
## Requirements
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

### Requirement: Evaluation mode SHALL perform no production GitHub writes

While executing an experiment, the runner and every stage it invokes SHALL perform no mutating
GitHub operation against production state. In particular, evaluation mode SHALL NOT set or remove
a label, post or edit a comment, create, edit, or merge a pull request, or push to a production
branch, and SHALL NOT transition any real issue's authoritative pipeline state. This restriction
SHALL be enforced by the evaluation-mode GitHub surface refusing mutating operations, rather than
relying on individual call sites to check a mode flag.

Because a local CLI harness can shell out directly rather than through that surface, evaluation
mode SHALL additionally deny mutating GitHub operations, pushes, and remote mutations at the
harness child process boundary. Every refusal by the evaluation-mode GitHub surface and every
denial at the process boundary SHALL be recorded in the cell's durable evidence, not only returned
in memory or written to the console.

#### Scenario: No mutating GitHub call occurs during an experiment

- **WHEN** a full experiment matrix is executed in either stage mode or end-to-end mode
- **THEN** no label set or removal, no comment creation or edit, no pull-request creation, edit,
  or merge, and no push to a production branch SHALL be performed

#### Scenario: A stage attempting a production write fails loudly

- **WHEN** a stage invoked in evaluation mode attempts a mutating GitHub operation
- **THEN** the evaluation-mode GitHub surface SHALL refuse the operation
- **AND** the cell SHALL record the refusal rather than silently completing as if the write had
  succeeded

#### Scenario: A harness shelling out directly is denied at the process boundary

- **WHEN** a treatment invokes the GitHub CLI or a push directly, bypassing the evaluation-mode
  GitHub surface
- **THEN** the attempt SHALL be denied at the harness child process boundary
- **AND** no production GitHub or remote state SHALL change

#### Scenario: Refusals and denials are durably recorded on the cell

- **WHEN** a cell records a GitHub-surface refusal or a process-boundary denial
- **THEN** that record SHALL be present in the cell's persisted record in the experiment output

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
`prompt_hash`, `config_hash`, `base_sha`, the fixture's `env_surface_hash` (the
environment-and-surface provenance hash), and the resolved execution sandbox mode under which the
cell ran. `prompt_hash` SHALL be computed over the materialized prompt text used for that cell,
`config_hash` over the effective configuration for that cell — which SHALL include the resolved
sandbox mode — and `env_surface_hash` SHALL be carried from the fixture's resolved
environment-fidelity contract and resolved capability surface, so that a prompt-template change, a
configuration change, a sandbox-mode change, or an environment/surface change is each detectable as
a difference between populations.

#### Scenario: Identity keys are present on every record

- **WHEN** any cell record is read from the experiment output
- **THEN** it SHALL contain `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
  `prompt_hash`, `config_hash`, `base_sha`, `env_surface_hash`, and the resolved sandbox mode

#### Scenario: Prompt and config changes are visible as hash differences

- **WHEN** two cells are executed with the same fixture and treatment but a different
  materialized prompt or a different effective configuration
- **THEN** their `prompt_hash` or `config_hash` values SHALL differ

#### Scenario: A sandbox-mode change is visible as a config-hash difference

- **WHEN** two cells are executed with the same fixture and treatment but different resolved
  execution sandbox modes
- **THEN** their `config_hash` values SHALL differ

#### Scenario: An environment or surface change is visible as a hash difference

- **WHEN** two cells are executed for fixtures identical except for one dependency's environment
  mode or a difference in the resolved capability surface
- **THEN** their `env_surface_hash` values SHALL differ

#### Scenario: A cell joins to ordinary run evidence

- **WHEN** a cell record and an ordinary pipeline run artifact are compared
- **THEN** the recorded identity keys SHALL be sufficient to determine whether they describe the
  same fixture, treatment, and base commit

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

### Requirement: An experiment cell SHALL be able to bind an API treatment to a model-endpoint executor with per-cell overrides

The eval runner SHALL be able to execute a treatment through a named `model-endpoint`
executor, supplying that cell's `model`, allowlisted `params`, and requested effort as
per-invocation overrides rather than by editing committed repository configuration. The
resolved overrides SHALL be derived deterministically from the cell's treatment coordinates,
so replaying the plan from the same manifest and seed produces the same request controls. A
treatment whose overrides are invalid for the bound executor — an unknown param key, or an
effort the executor's dialect cannot express without an explicit opt-in — SHALL fail before
the request is sent, and that failure SHALL be classified as a configuration/infrastructure
failure rather than as a treatment outcome.

#### Scenario: Per-cell model override reaches the request

- **WHEN** a cell binds an API treatment to a `model-endpoint` executor with a model
  coordinate
- **THEN** the request issued for that cell SHALL carry that model
- **AND** the repository's committed configuration SHALL be unmodified

#### Scenario: Overrides are deterministic across replays

- **WHEN** the same plan is replayed from the same manifest and seed
- **THEN** each cell SHALL resolve to the same model, params, and requested effort as before

#### Scenario: Invalid override is not a treatment outcome

- **WHEN** a cell's overrides are invalid for the bound executor
- **THEN** the cell SHALL fail before any request is issued
- **AND** the failure SHALL be recorded as an infrastructure or configuration failure, not as
  a completed treatment outcome

---

### Requirement: Experiment cell records SHALL distinguish API endpoint treatments from CLI harness treatments

Every experiment cell record SHALL carry the execution/authentication class of the treatment
it executed, marking a `model-endpoint` treatment as an API-key endpoint execution and a
local CLI harness treatment as a subscription/OAuth CLI execution. Cell records for API
treatments SHALL additionally carry the endpoint provenance captured for the invocation —
requested and resolved model, upstream provider, request id, usage, and cost — with unknown
values represented as such. A report or aggregation SHALL be able to separate the two classes
from the recorded field alone.

#### Scenario: API cell record marked and carries provenance

- **WHEN** a cell executes an API treatment through a `model-endpoint` executor
- **THEN** its record SHALL carry the API-key endpoint execution class
- **AND** SHALL carry the captured endpoint provenance for that invocation

#### Scenario: CLI cell record keeps its own class

- **WHEN** a cell executes a treatment through a local CLI harness
- **THEN** its record SHALL carry the CLI execution class and SHALL NOT be marked as an
  API-key endpoint execution

#### Scenario: Classes are separable from the record alone

- **WHEN** an aggregation groups cells by execution class
- **THEN** it SHALL be able to do so from the recorded class field without inspecting the
  treatment's model or provider values

### Requirement: A CLI-harness cell SHALL deliver its declared effort coordinate to the harness invocation

A cell executed through a local CLI harness SHALL cause the harness process to be invoked with the
effort declared by that cell's treatment, expressed as the resolved harness adapter's own native
reasoning-effort control. A cell whose treatment declares no effort SHALL be invoked with no
effort control at all, exactly as before. The delivered effort SHALL be observable in the harness
process's command line, and SHALL be the same value the cell's recorded treatment coordinates
claim.

#### Scenario: A declared effort reaches the harness command line

- **WHEN** a cell's treatment declares an effort and is executed through a local CLI harness
- **THEN** the harness process SHALL be invoked with that adapter's native reasoning-effort
  control carrying the declared value

#### Scenario: Two cells differing only in effort invoke the harness differently

- **WHEN** two cells share a fixture, harness, and model but declare different efforts
- **THEN** their harness invocations SHALL differ in the delivered reasoning-effort control

#### Scenario: A cell declaring no effort is invoked unchanged

- **WHEN** a cell's treatment declares no effort
- **THEN** the harness process SHALL be invoked with no reasoning-effort control

#### Scenario: Effort delivery is verified at the command line, not at the call site

- **WHEN** the runner's effort-delivery behavior is tested
- **THEN** the assertion SHALL be made against the arguments the harness process actually
  receives, so an invocation option that is accepted but discarded before reaching the process
  SHALL fail the test

### Requirement: A cell SHALL NOT be recorded as a completed treatment carrying an effort the resolved harness cannot express

The runner SHALL fail a cell before invoking the harness whenever that cell's treatment declares
an effort the resolved harness cannot express — an unregistered custom CLI, or an adapter whose
declared capabilities include no reasoning-effort control — and SHALL classify the failure as an
infrastructure or configuration failure rather than as a treatment outcome. The
failure message SHALL name the harness and the requested effort. A cell that declares no effort
SHALL be unaffected by this rule.

#### Scenario: An inexpressible effort fails before invocation

- **WHEN** a cell declares an effort against a harness with no reasoning-effort control
- **THEN** the cell SHALL fail before the harness is invoked
- **AND** the failure SHALL be recorded as an infrastructure or configuration failure, not as a
  completed treatment outcome
- **AND** the failure message SHALL name the harness and the requested effort

#### Scenario: A cell declaring no effort still runs on such a harness

- **WHEN** a cell declares no effort against a harness with no reasoning-effort control
- **THEN** the cell SHALL execute normally

### Requirement: Review-mode prompts SHALL carry the production structured verdict contract

The runner SHALL state the production structured verdict contract in the prompt it
materializes for the `review` stage — in stage mode and as part of an `end-to-end`
sequence — namely the review verdict JSON schema and an instruction to return only that
JSON object and nothing else. The schema
text SHALL be substituted from the single-sourced `REVIEW_VERDICT_SCHEMA_BLOCK` constant
rather than duplicated in the evaluation runner, so a change to the production contract
reaches review-mode evaluation automatically.

The materialized prompt SHALL contain no unsubstituted placeholder token. Prompts for the
`planning`, `plan-review`, `implementing`, `fix`, and `shipcheck` stages SHALL be
unchanged by this requirement.

#### Scenario: A review-mode prompt states the verdict contract

- **WHEN** the runner materializes the prompt for a `review`-stage cell from a fixture's frozen stage-entry artifact
- **THEN** the prompt SHALL contain the exact text of `REVIEW_VERDICT_SCHEMA_BLOCK`
- **AND** SHALL instruct the reviewer to return only that JSON object and no other prose

#### Scenario: The contract text tracks the production constant

- **WHEN** `REVIEW_VERDICT_SCHEMA_BLOCK` changes
- **THEN** the review-mode evaluation prompt SHALL carry the changed text without a separate edit to the evaluation runner
- **AND** a test SHALL fail if the review-mode prompt's schema text diverges from the constant

#### Scenario: Non-review stage prompts are unchanged

- **WHEN** the runner materializes the prompt for a `planning`, `plan-review`, `implementing`, `fix`, or `shipcheck` cell
- **THEN** the materialized text SHALL be identical to the text materialized before this change
- **AND** SHALL NOT contain the review verdict schema block

#### Scenario: No unsubstituted placeholder reaches the harness

- **WHEN** any stage prompt is materialized
- **THEN** the prompt SHALL contain no literal `{{schema_block}}` or other unsubstituted `{{…}}` token

---

### Requirement: Review-stage output SHALL be parsed by the production verdict parser

The runner SHALL extract a review cell's findings using the production review verdict
parsers (`core/scripts/stages/review-parsing.ts`) rather than an evaluation-local JSON
reader, so any verdict a production review round would have parsed is a verdict the
evaluation parses. This SHALL include output in which the verdict appears inside a fenced
JSON block or as an inline JSON object surrounded by other text.

Parsed findings SHALL retain every declared `ReviewFinding` field the treatment emitted,
including the `file`, `line_start`, `line_end`, and `severity` fields the review grader
matches against seeded defects. When a verdict is parsed, its findings SHALL be recorded
as `detail.findings` so the review grader consumes them; when no verdict can be parsed,
`detail.findings` SHALL be absent rather than an empty array.

#### Scenario: A fenced verdict block is parsed

- **WHEN** a review-stage treatment returns a fenced ```json verdict block surrounded by other prose
- **THEN** the runner SHALL parse it and record its findings as `detail.findings`

#### Scenario: A bare verdict object is still parsed

- **WHEN** a review-stage treatment returns the verdict JSON object as its entire output
- **THEN** the runner SHALL parse it and record its findings as `detail.findings`, exactly as before this change

#### Scenario: Parsed findings reach the review grader

- **WHEN** a review-stage treatment returns a valid verdict whose finding names the path and overlapping line range of a fixture's seeded defect
- **THEN** the review grader SHALL count that defect as a true positive rather than a false negative

#### Scenario: Findings retain the fields the grader matches on

- **WHEN** a review-stage treatment emits a finding carrying `file`, `line_start`, `line_end`, and `severity`
- **THEN** the finding recorded on `detail.findings` SHALL carry those values unchanged

---

### Requirement: A review cell record SHALL disclose whether the treatment satisfied the verdict contract

Every completed `review`-stage cell record SHALL carry a parse-provenance value on its
detail distinguishing at least: output that satisfied the full verdict contract, output
recovered by tolerant parsing, and output from which no verdict could be parsed. Prose or
other non-verdict output SHALL be classified as unparseable and SHALL NOT be recorded as a
verdict carrying zero findings, so a genuinely empty review is distinguishable from a
treatment that never answered in the contract.

Unparseable review output SHALL remain a completed treatment outcome, not an
infrastructure error — the treatment was asked correctly and answered non-compliantly, and
that non-compliance is itself a measured result. The value SHALL be an additive detail key,
consistent with the append-only results contract.

#### Scenario: Contract-satisfying output is disclosed as such

- **WHEN** a review-stage treatment returns a verdict satisfying the full verdict schema
- **THEN** the cell record SHALL disclose a parse provenance indicating the contract was satisfied

#### Scenario: Prose output is disclosed as unparseable

- **WHEN** a review-stage treatment returns prose containing no parseable verdict
- **THEN** the cell record SHALL disclose a parse provenance of unparseable
- **AND** `detail.findings` SHALL be absent
- **AND** the cell SHALL be recorded with result class `completed`, not as an infrastructure error

#### Scenario: A recovered partial verdict is distinguishable from a compliant one

- **WHEN** a review-stage treatment returns a JSON verdict whose findings omit a field the strict contract requires
- **THEN** the runner SHALL still record the recovered findings as `detail.findings`
- **AND** the cell record SHALL disclose a parse provenance distinct from the contract-satisfying one

#### Scenario: Both execution paths disclose provenance

- **WHEN** a `review`-stage cell is executed either through a local CLI harness or through a model-endpoint executor treatment
- **THEN** the cell record SHALL carry the parse-provenance value in both cases

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

