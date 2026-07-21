## Why

The stage eval runner (#432) can now hold everything but the treatment constant: it replays a
frozen fixture through a matrix of harness/model/effort treatments from the same base commit and
writes one `runs.jsonl` record per cell. What it deliberately does **not** do is say whether a cell
was any *good*. Its records carry a `result_class` and a raw treatment outcome blob — nothing that
answers "did this fix actually work", "did this reviewer find the bug we planted", or "is Codex at
high effort worth 3× the wall clock".

Without grading, the only way to read an experiment is to eyeball diffs, which reintroduces exactly
the anecdote the runner was built to eliminate. And without uncertainty-aware comparison, the first
thing anyone will do with grades is compute two headline averages and declare a winner — an
unpaired mean over a handful of noisy fixtures, where fixture difficulty dominates the treatment
effect and a two-point gap is indistinguishable from luck.

This change adds the missing half: **objective grading** of eval cells, and **paired, interval-aware
comparative reporting** over those grades. Grading is deterministic-first — hidden tests, seeded
review defects, acceptance-criterion checks, regression and out-of-scope detection — with model
judging strictly optional, separately recorded, and never mixed into a deterministic score. Reporting
compares treatments **within** each fixture (paired deltas) rather than across pooled populations,
reports confidence intervals and completion/failure rates alongside every effect, and surfaces a
quality-versus-duration/cost Pareto frontier so a faster-but-worse configuration cannot masquerade as
an improvement.

## What Changes

- **Fixture contract extension** (`eval-fixture-contract`): a fixture may additionally declare
  **hidden checks** (deterministic commands never exposed to the treatment), **seeded defects**
  (ground truth for review fixtures: identity, location, expected severity), **acceptance criteria**
  (checkable statements the result must satisfy), an **allowed-change boundary** (the paths a
  correct result may touch), and **grader version identifiers**. All are optional; existing fixtures
  remain valid.
- **A grading layer** (`eval-graders`) that reads a completed experiment's records and emits grades
  without touching the source run artifacts:
  - *Implementation/fix grades*: hidden-test pass rate, acceptance-criterion completion, regression
    count (checks that passed at base and fail after), out-of-scope change count (changes outside the
    allowed-change boundary).
  - *Review grades*: seeded-defect precision, recall, F1, severity calibration, and false-positive
    count, computed by matching reported findings against the fixture's seeded-defect ground truth.
  - *Planning grades*: a **versioned rubric** scoring requirement coverage, unsupported assumptions,
    actionability, and downstream compatibility. A treatment model's own self-assessment is never
    consumed as ground truth.
  - *Optional model-judge results*: recorded as a separate, clearly-labelled record carrying judge
    harness, model, and prompt version — never merged into a deterministic score and never able to
    change one.
  - *Blinded human adjudication records*: a checked-in record form for resolving judge/test
    disagreements, where the adjudicator's input identifies the cell only by an opaque key.
- **Comparative reporting** (`eval-comparative-reporting`): paired per-fixture treatment deltas
  against a declared baseline treatment, completion and failure-class rates, confidence intervals on
  every reported effect, and a quality-versus-duration and quality-versus-cost Pareto frontier.
  Results are groupable by stage, harness, provider/auth class, model, effort, task category, and
  risk.
- **Unknown is not zero**: a cell with missing token/cost telemetry is reported as `unknown` and
  excluded from cost aggregates with an explicit coverage figure, consistent with the existing
  `cost_source` contract (#429). Cost aggregates never impute zero.
- **Stable additive artifacts**: `grades.jsonl` and `summary.json` are written alongside the
  experiment's existing files. `runs.jsonl`, `failures.jsonl`, `plan.json`, and `manifest.json` are
  read-only inputs and are never rewritten. Grading is re-runnable and deterministic.
- **A checked-in synthetic fixture set** plus recorded cell records proves grading and aggregation
  end-to-end in CI with no live model call, no network, and no provider credential.

## Acceptance Criteria

- [ ] A fixture may declare hidden checks, seeded defects, acceptance criteria, an allowed-change
      boundary, and grader version identifiers; a fixture omitting all of them still validates.
- [ ] Hidden checks are never included in the inputs handed to a treatment, and a fixture that
      exposes a hidden check as a public check is rejected by name.
- [ ] Grading a completed experiment produces `grades.jsonl` (one record per graded cell) and
      `summary.json` in the experiment output directory, and leaves `runs.jsonl`,
      `failures.jsonl`, `plan.json`, and `manifest.json` byte-identical.
- [ ] Grading the same records twice produces byte-identical `grades.jsonl` and `summary.json`.
- [ ] An implementation/fix grade reports hidden-test pass rate, acceptance-criterion completion,
      regression count, and out-of-scope change count.
- [ ] A review grade reports precision, recall, F1, severity calibration, and false-positive count
      against the fixture's seeded defects.
- [ ] A planning grade reports requirement coverage, unsupported assumptions, actionability, and
      downstream compatibility under a named, versioned rubric, and a self-score emitted by the
      treatment is never read as ground truth.
- [ ] A model-judge result is stored in its own record carrying judge harness, model, and prompt
      version, and deterministic grade fields are identical whether or not judging ran.
- [ ] A human adjudication record can be attached to a judge/test disagreement, and the record form
      identifies the cell by an opaque key rather than by treatment.
- [ ] `summary.json` reports, per treatment, paired per-fixture deltas against the declared baseline,
      computed only over fixtures where both treatments have a completed cell.
- [ ] `summary.json` reports completion rate and per-failure-class rates, and no `infra_error`,
      `auth_error`, or `timeout` cell contributes to a quality metric.
- [ ] Every reported aggregate effect carries a confidence interval and the sample size it was
      computed from.
- [ ] `summary.json` reports a quality-versus-duration and a quality-versus-cost Pareto frontier
      identifying non-dominated treatments.
- [ ] Results can be grouped by stage, harness, provider/auth class, model, effort, task category,
      and risk.
- [ ] A cell with no cost telemetry is reported as `unknown`, is excluded from cost aggregates, and
      the cost coverage fraction is reported; no cost aggregate imputes zero.
- [ ] A checked-in synthetic fixture set plus recorded cell records exercises grading and aggregation
      in CI with no live model call, network request, real git operation, or subprocess spawn.

## Out of Scope

- A hosted leaderboard or any published result service.
- Declaring a universally best harness, or normalizing provider effort labels into comparable compute.
- Replacing the repository test suite, `eval-gate`, or `shipcheck` as production gates — grades never
  participate in the label-driven state machine and never gate a PR.
- Harness cost extraction itself, owned by #429; this change consumes the existing
  `actual`/`estimated`/`unknown` cost provenance.
- The experiment scheduler, worktree isolation, and cell execution, owned by #432.
- Routing production traffic based on grades.
