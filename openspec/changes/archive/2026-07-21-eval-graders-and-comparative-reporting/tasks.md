## 1. Fixture contract extension

- [ ] 1.1 Extend the `Fixture` type in `core/scripts/evals/types.ts` with optional
      `hidden_checks`, `seeded_defects`, `acceptance_criteria`, `allowed_change_paths`, and
      versioned `grader_refs`.
- [ ] 1.2 Extend the runtime validator in `core/scripts/evals/fixture.ts`: reject a check declared
      both public and hidden, a duplicate `defect_id`, a seeded defect missing its location or
      `expected_severity`, and an unsupported grader version — each naming the fixture and the
      offending field. Existing fixtures with none of the new fields must still validate.
- [ ] 1.3 Ensure hidden checks are excluded from everything handed to a treatment (stage-entry
      artifacts and materialized prompts) in `core/scripts/evals/stage-adapters.ts`.
- [ ] 1.4 Add synthetic fixtures under `core/evals/fixtures/` covering an implementation/fix
      fixture (hidden checks + acceptance criteria + allowed-change boundary), a review fixture
      (seeded defects), and a planning fixture (requirement expectations).

## 2. Grade model and grading pass

- [ ] 2.1 Define grade record types in `core/scripts/evals/grading/types.ts`: cell identity keys,
      grader id/version list, per-stage grade payloads, judge record, adjudication record.
- [ ] 2.2 Implement the grading entry point in `core/scripts/evals/grading/grade.ts`: read
      `manifest.json`, `plan.json`, `runs.jsonl`, `failures.jsonl` and the fixtures; open no
      runner-written file for writing; append `grades.jsonl`.
- [ ] 2.3 Grade only `completed` cells; carry `infra_error` / `auth_error` / `timeout` cells
      forward as reliability counts with no substitute score.
- [ ] 2.4 Establish and cache the base-commit check baseline keyed by
      `(fixture_id, base_commit, check)` so regressions are measured, not inferred.

## 3. Deterministic graders

- [ ] 3.1 Implementation/fix grader: hidden-test pass rate, per-criterion acceptance completion,
      regression count (pass-at-base → fail-after), pre-existing-failure count, out-of-scope change
      count (`null` when no allowed-change boundary is declared).
- [ ] 3.2 Review grader: deterministic finding↔defect matching by path + line-range overlap;
      precision, recall, F1, false-positive count, and a signed severity-difference distribution
      (never collapsed to one number). No model call in the match.
- [ ] 3.3 Planning grader: versioned rubric over requirement coverage, unsupported assumptions,
      actionability, downstream compatibility; stamp `rubric_version` into every planning grade;
      record any treatment self-score as an observation and never read it as a grade input.

## 4. Optional judging and adjudication

- [ ] 4.1 Optional model judge writing separate records with `judge_harness`, `judge_model`,
      `judge_prompt_version`, and verdict; disabled by default.
- [ ] 4.2 Record judge-vs-deterministic disagreements as their own records, leaving deterministic
      grades untouched.
- [ ] 4.3 Blinded adjudication: derive an opaque key from `cell_id`, emit adjudication material
      containing no harness/provider/model/effort, and store adjudication records joinable back by
      that key.

## 5. Comparative reporting

- [ ] 5.1 Reduce replicates of a fixture × treatment to a single value before pairing.
- [ ] 5.2 Compute paired per-fixture deltas against the declared baseline treatment; record
      fixtures excluded for lack of a pair explicitly.
- [ ] 5.3 Compute completion rate and per-failure-class rates over each treatment's planned cells.
- [ ] 5.4 Compute confidence intervals over the paired deltas with a seeded, recorded method; mark
      effects below the sufficiency threshold as `underpowered`.
- [ ] 5.5 Compute quality-versus-duration and quality-versus-cost Pareto frontiers; emit no
      combined weighted score.
- [ ] 5.6 Implement grouping by stage, harness, provider/auth class, model, effort, task category,
      and risk, with an explicit unknown group.
- [ ] 5.7 Cost handling: exclude `cost_source: unknown` cells, report the coverage fraction and the
      actual/estimated composition, never impute zero.
- [ ] 5.8 Write versioned `summary.json` deterministically without mutating any input artifact.

## 6. CLI surface

- [ ] 6.1 Add `pipeline evals grade <experiment-dir>` and `pipeline evals report <experiment-dir>`
      to `core/scripts/pipeline.ts`, with a `--baseline <treatment_id>` flag and an opt-in judging
      flag.
- [ ] 6.2 Register the new sub-commands and their allowed flags in
      `core/scripts/command-registry.ts` and add `--help` usage lines.

## 7. Tests

- [ ] 7.1 Fixture validation: public/hidden overlap, duplicate `defect_id`, incomplete seeded
      defect, unsupported grader version; and a fixture declaring none of the new fields still
      validates.
- [ ] 7.2 Hidden-check leakage: no hidden check appears in any treatment input or materialized
      prompt.
- [ ] 7.3 Additivity: grading leaves `manifest.json`, `plan.json`, `runs.jsonl`, `failures.jsonl`
      byte-identical; regrading produces byte-identical `grades.jsonl` and `summary.json`.
- [ ] 7.4 Implementation/fix grader: hidden-test rate, acceptance completion, pass-at-base →
      fail-after counted as a regression, fail-at-both counted as pre-existing, out-of-scope count,
      and `null` out-of-scope when no boundary is declared.
- [ ] 7.5 Review grader: precision/recall/F1 from a known match set, unmatched finding → false
      positive, missed defect → false negative, and over/under severity calls that must not cancel.
- [ ] 7.6 Planning grader: all four rubric dimensions present, `rubric_version` recorded, and a
      grade identical with and without a treatment self-score in the output.
- [ ] 7.7 Judge separation: deterministic grade fields byte-identical with judging enabled and
      disabled; judge records carry harness/model/prompt version; disagreements recorded.
- [ ] 7.8 Adjudication blinding: adjudication material contains no harness/provider/model/effort
      string; the opaque key resolves to exactly one cell.
- [ ] 7.9 Failure classes: an `infra_error` / `auth_error` / `timeout` cell receives no grade and
      contributes no zero; a `completed` but poor cell is graded.
- [ ] 7.10 Pairing: unpaired fixture excluded and reported; differing replicate counts leave the
      aggregate unchanged; the baseline is named in the summary.
- [ ] 7.11 Intervals: every aggregate carries an interval and n; repeated summarization is
      byte-identical; a small sample is marked `underpowered`.
- [ ] 7.12 Pareto: a dominated treatment is excluded; a faster-but-worse treatment shows both the
      quality effect and the duration difference with no combined score.
- [ ] 7.13 Grouping: one entry per distinct value for each supported dimension; missing values land
      in an explicit unknown group.
- [ ] 7.14 Cost: an unknown-cost cell is excluded rather than zeroed; coverage fraction and
      actual/estimated composition are reported.
- [ ] 7.15 All tests run against checked-in synthetic fixtures and recorded cell records — no live
      model call, network, real git, or subprocess.

## 8. Docs, mirror, gate

- [ ] 8.1 Document the new fixture fields, the graders and their versions, the rubric, and the
      `evals grade` / `evals report` commands in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`,
      stating that grades never gate a PR or participate in the state machine.
- [ ] 8.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 8.3 Run `npm run ci` from the repo root and confirm it is green.
