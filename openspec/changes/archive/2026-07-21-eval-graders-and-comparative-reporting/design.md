## Context

`#432` shipped the experiment harness: `core/scripts/evals/` expands a manifest into cells, runs each
cell in an isolated worktree at the fixture's `base_commit`, and appends one `CellRecord` per cell to
`runs.jsonl` / `failures.jsonl`. A `CellRecord` carries identity (`experiment_id`, `fixture_id`,
`treatment_id`, `replicate`, `prompt_hash`, `config_hash`, `base_sha`), a `result_class`, and an
opaque `detail` blob. The `Fixture` type already reserves `public_checks` and `grader_refs` — grader
references exist but nothing resolves them.

This change resolves them, and adds the statistics layer that turns a pile of graded cells into a
defensible comparison.

Two naming collisions are worth stating plainly rather than averaging away:

- `eval-gate` (`stages/eval.ts`) is a production **gate** on a real PR. This change is offline
  **grading** of frozen fixtures. They share a word and nothing else; `stages/eval.ts` is untouched.
- `factory-scoreboard` aggregates **production run artifacts** over a time window to answer "how is
  the factory doing". This change aggregates **experiment cells** to answer "which treatment is
  better". The scoreboard's grouping dimensions are a good precedent for the grouping surface here,
  but the two consume different inputs and are not merged.

## Goals / Non-Goals

Goals:
- Determinism: grading is a pure function of (records, fixtures, graders). Re-running produces
  byte-identical output.
- Separation: a deterministic grade can never be moved by a model's opinion.
- Honest uncertainty: no effect is reported without an interval and an n.
- Additivity: grading never mutates the runner's output.

Non-Goals:
- Deciding policy from the numbers. The report ranks; a human chooses.
- Grading production runs. Grades attach to eval cells only.
- Inventing cost data. Cost provenance comes from #429 verbatim.

## Decisions

### 1. Grading is a separate pass over an immutable experiment directory

Grading reads `manifest.json`, `plan.json`, `runs.jsonl`, `failures.jsonl` and the referenced
fixtures, and writes `grades.jsonl` + `summary.json` into the same directory. It opens nothing for
writing that the runner wrote.

Rationale: the runner's append-only contract is load-bearing for resume, and a grader that rewrote
records in place would make "the experiment" and "the interpretation of the experiment" the same
mutable artifact — you could never tell whether a number changed because the data changed or because
the rubric did. As a separate pass, grading is also re-runnable after a rubric version bump against
the same frozen population, and `grades.jsonl` records the grader versions it used.

Rejected: grading inline during cell execution. It would make an experiment un-regradeable, put
grader defects inside the measurement, and let a slow hidden-test suite count toward the cell's
measured duration.

### 2. Hidden checks are a fixture field the treatment never sees

`public_checks` are visible to the treatment (a candidate may run them). Hidden checks are resolved
only by the grader. The fixture loader rejects a fixture where the same check appears in both lists,
because a "hidden" check the treatment can read is a contaminated measurement that would look fine.

Rationale: the standard failure mode of test-based grading is a treatment that optimizes the grader
rather than the task. Enforcing disjointness at load time makes the contamination a validation error
rather than a silently inflated score.

### 3. Regressions and out-of-scope changes are measured, not inferred

A *regression* is a check that passed at `base_commit` and fails on the candidate result — which
means the grader establishes a **baseline check result at the fixture's base commit** and compares.
A check failing on both is a pre-existing failure, not a regression, and is reported as such.

An *out-of-scope change* is a changed path outside the fixture's declared `allowed_change_paths`.
Fixtures that declare no boundary report out-of-scope count as `null` (not `0`) — absence of a
declared boundary is absence of evidence.

### 4. Review grading matches findings to seeded defects by location and identity

A review fixture declares seeded defects with a stable `defect_id`, a location (path plus line
range), and an `expected_severity`. A reported finding matches a defect when it names the same path
and overlaps the defect's line range. Matched → true positive; unmatched defect → false negative;
unmatched finding → false positive. Precision, recall, and F1 follow. **Severity calibration** is
reported as the signed distribution of (reported severity − expected severity) over matched defects,
not collapsed into a single accuracy number, because over- and under-calling are different failure
modes with different costs and a mean would cancel them.

Rejected: LLM-judged finding-to-defect matching. It would put a model in the middle of the one grade
this change exists to make deterministic.

### 5. Planning grades use a versioned rubric, and a self-score is data, not truth

Planning output has no compiler. The rubric therefore names four dimensions — requirement coverage,
unsupported assumptions, actionability, downstream compatibility — each scored against fixture-declared
expectations (e.g. the requirement list the plan must cover), and is stamped with a `rubric_version`
carried into every planning grade. If a treatment emits a self-assessment, it is recorded as an
observation on the cell and explicitly never read as a grade input; otherwise the model under test
would be grading itself.

### 6. Model judging is a sidecar, never a term in a deterministic score

Judge results are separate records carrying `judge_harness`, `judge_model`, `judge_prompt_version`,
and the verdict. The invariant, backed by a test: deterministic grade fields are byte-identical
whether or not judging ran. Judging exists to *flag disagreement* with the deterministic grade —
disagreements are what a human adjudicates.

### 7. Human adjudication is blinded by construction

An adjudication request identifies the cell by an opaque key derived from `cell_id`; the treatment
axes (harness, model, effort) are not part of what the adjudicator reads. The adjudication record
stores the opaque key, the verdict, and the rationale; unblinding happens at aggregation time by
rejoining on the key.

Rationale: an adjudicator who can see "this one was Claude at high effort" is not an independent
signal, and the entire point of adjudicating a judge/test disagreement is independence.

### 8. Comparison is paired within fixture, against a declared baseline

For each fixture, and each metric, the report computes `metric(treatment) − metric(baseline)` using
only fixtures where **both** treatments have a `completed` cell. Aggregation is over those per-fixture
deltas.

Rationale: fixture difficulty is typically a far larger source of variance than the treatment effect.
An unpaired comparison over a matrix with any missing cells is also silently biased — a treatment that
times out on the hard fixtures looks better on the easy ones it survived. Pairing eliminates both. The
number of paired fixtures is reported next to every delta, and fixtures dropped for lack of a pair are
reported explicitly rather than silently omitted.

Replicates of the same fixture × treatment are reduced to a per-cell-group value before pairing, so a
treatment with more replicates does not gain weight.

### 9. Every effect carries an interval; the interval method is named in the output

Confidence intervals are computed from the paired deltas and the method (and its parameters, e.g.
bootstrap resample count and seed) is recorded in `summary.json`, so an interval is reproducible.
Bootstrap resampling uses a seed carried in the summary — no unseeded randomness, since grading must
be deterministic.

Small-n honesty is a first-class output: when the paired sample size is below a stated threshold the
report marks the effect `underpowered` rather than dropping it or presenting it as conclusive.

### 10. Failure classes never touch quality metrics, and unknown cost never becomes zero

`infra_error`, `auth_error`, and `timeout` cells are excluded from quality aggregates and reported as
rates instead — a treatment that fails to run is a reliability finding, not a quality finding, and
folding it into either direction (as a zero score, or by dropping it silently) misreports it.

Cost follows the `stage-cost-accounting` contract exactly: `cost_source: unknown` → excluded from the
aggregate, counted in a reported coverage fraction. A Pareto frontier computed over partial cost
coverage states that coverage next to it.

### 11. The Pareto frontier is reported, not collapsed into a score

Quality-versus-duration and quality-versus-cost frontiers list the non-dominated treatments. No
weighted "value score" is invented, because the exchange rate between a quality point and a dollar or
a minute is the reader's to choose, and baking one in would smuggle a policy decision into a
measurement.

## Risks / Trade-offs

- **Grader overfitting**: fixtures with weak hidden checks make every treatment look equal. Mitigated
  by grader version identifiers and by reporting per-fixture deltas, where a fixture that never
  discriminates is visible as a flat row.
- **Small fixture sets**: intervals will be wide and many effects will be `underpowered`. This is the
  honest outcome and is surfaced rather than hidden.
- **Baseline check cost**: establishing the base-commit check result per fixture costs an extra
  execution. It is cacheable by `(fixture_id, base_commit, check)` since both are immutable.

## Migration

Purely additive. New fixture fields are optional and existing fixtures validate unchanged. Grading is
a new command; not invoking it leaves runner behavior and production pipeline behavior identical.
