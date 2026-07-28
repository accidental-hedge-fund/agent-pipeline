## Why

`pipeline evals run` in `mode: "review"` materializes its harness prompt in
`core/scripts/evals/stage-adapters.ts` (`materializeStagePrompt`). For the `review`
stage that prompt is exactly three things:

```
Review the following diff for correctness, safety, and adherence to the plan.

## Task
<fixture.task_input>

## Stage input
<JSON of fixture.stage_entry_artifacts.review>
```

It never states an output contract. Production review does: `review_standard.md` and
`review_adversarial.md` both substitute `{{schema_block}}` with
`REVIEW_VERDICT_SCHEMA_BLOCK` (`core/scripts/review-schema.ts`) and demand JSON only.
So the eval asks a reviewer for a review and gets prose — which is exactly what
happened on the harness-pair selection screen: both Codex and Grok returned
non-parseable output.

The capture side compounds it. `parseReviewFindings` in
`core/scripts/evals/executor.ts` is a bespoke `JSON.parse(stdout)` that accepts only a
whole-stdout JSON object. It does not do what production's parsers do — extract a
fenced ```json block or an inline `{...}` object (`parseStructuredVerdict` /
`parseStrictVerdict`, `core/scripts/stages/review-parsing.ts`). A harness that emits a
perfectly valid verdict inside a fenced block, or with one line of preamble, still
yields `undefined`.

The consequence is a silently wrong measurement, not a visible failure:
`detail.findings` stays absent, `parseReportedFindings(undefined)` returns `[]`, and
`gradeReview` records every seeded defect as a false negative. A reviewer that found
every defect and a reviewer that found none produce the identical grade — precision
`null`, recall `0`. Nothing in the cell record distinguishes "the treatment reviewed
badly" from "the harness never received the output contract", so the review grader's
numbers are unusable for harness-pair selection.

This is the same dual-parser class as #620 (`parseStrictVerdict` field strip), which
landed separately: the eval path re-implements a contract that is already
single-sourced in `review-schema.ts` / `review-parsing.ts`, and drifts from it.

## What Changes

- **Review-stage prompt carries the production contract.** `materializeStagePrompt`,
  for the `review` stage only, appends the single-sourced `REVIEW_VERDICT_SCHEMA_BLOCK`
  plus a JSON-only output instruction, so an eval reviewer is asked for exactly the
  shape production asks for. Substitution is from the constant — the eval never keeps
  its own copy of the schema, and never emits a literal `{{schema_block}}` token.
- **Capture reuses the production parser.** `parseReviewFindings` stops hand-rolling
  `JSON.parse` and routes review-stage stdout through `review-parsing.ts` — gaining
  fenced/inline extraction and the shared finding projection (#620), so eval findings
  carry the same fields production findings do.
- **Parse outcome is disclosed on the cell record.** A new
  `detail.review_verdict_parse` value distinguishes a contract-satisfying verdict, a
  tolerantly-recovered one, and unparseable output — so a zero-recall grade can be read
  as a genuine miss rather than a harness that never answered in the contract.
- **Drift guards.** Tests assert the review-mode eval prompt contains the exact
  `REVIEW_VERDICT_SCHEMA_BLOCK` text (fails if the constant changes and the eval prompt
  does not follow), and assert the five non-review stage prompts are byte-identical to
  today's materialization.
- **End-to-end regression.** A `review` cell driven by a fake harness that emits a valid
  fenced verdict produces `detail.findings`, which reaches `gradeReview` and yields
  non-zero true positives against the fixture's seeded defects.

No change to the review verdict schema itself, to production review prompts, to the
review policy, or to grader math.

## Capabilities

### Modified Capabilities
- `stage-eval-runner`: review-mode prompt materialization SHALL carry the production
  structured verdict contract, review-stage output SHALL be parsed by the production
  verdict parser into `detail.findings`, and the cell record SHALL disclose whether the
  treatment satisfied that contract.

## Impact

- `core/scripts/evals/stage-adapters.ts` — review-stage prompt materialization.
- `core/scripts/evals/executor.ts` — `parseReviewFindings` + parse-provenance detail.
- `core/scripts/evals/types.ts` — the parse-provenance value, if it needs a declared type.
- `core/test/evals-executor.test.ts` (and a stage-adapters prompt test) — drift guards
  and the end-to-end review-cell regression.
- `plugin/` — regenerated mirror.
- Existing recorded experiments are unaffected: the new detail key is additive and the
  results contract is append-only.

## Out of Scope

- The `plan-review` stage's own output contract. Its prompt stays as-is; the API path's
  existing findings capture for `plan-review` cells is unchanged in behavior (output
  without the contract remains unparseable, exactly as today).
- Any change to `REVIEW_VERDICT_SCHEMA_BLOCK`, `review_standard.md`,
  `review_adversarial.md`, review policy thresholds, or `gradeReview` scoring math.
- Re-running or re-grading previously recorded experiments.
- #620's parser field round-trip, which landed separately and is a dependency of the
  shared-projection reuse here, not part of this change.

## Acceptance Criteria

- [ ] The materialized `review`-stage eval prompt contains the exact text of
      `REVIEW_VERDICT_SCHEMA_BLOCK`, substituted from the constant rather than copied.
- [ ] The materialized `review`-stage eval prompt contains an instruction to return
      only that JSON object and no other prose.
- [ ] The materialized `review`-stage eval prompt contains no literal `{{schema_block}}`
      (or any other unsubstituted `{{…}}`) token.
- [ ] A test derived from the `REVIEW_VERDICT_SCHEMA_BLOCK` constant fails if the eval
      review prompt's schema text diverges from it.
- [ ] The materialized prompts for `planning`, `plan-review`, `implementing`, `fix`, and
      `shipcheck` are byte-identical to their pre-change output, asserted by test.
- [ ] Harness stdout that is a fenced ```json verdict block (with surrounding prose)
      parses into `detail.findings` for a `review` cell — the current bespoke
      `JSON.parse(stdout)` returns `undefined` for this input.
- [ ] Harness stdout that is a bare verdict JSON object (today's only accepted shape)
      still parses into `detail.findings` — no regression.
- [ ] Parsed eval findings carry every field named in `REVIEW_SCHEMA_FIELDS.finding`
      that the harness emitted, including `file`, `line_start`, `line_end`, and
      `severity`, which `parseReportedFindings` requires.
- [ ] An end-to-end `review` cell run against a fake harness emitting a valid verdict
      that names the fixture's seeded defect path/lines produces a `ReviewGrade` with
      `true_positives > 0` and `recall === 1` — proving the output reaches the grader,
      not just the parser.
- [ ] The same end-to-end cell run against a fake harness emitting prose records the
      cell as parse-failed on `detail.review_verdict_parse` (not as a verdict with zero
      findings), and does not fail the cell as an infra error.
- [ ] `detail.review_verdict_parse` is present on every completed `review`-stage cell
      record and distinguishes at least: contract-satisfying, tolerantly-recovered, and
      unparseable output.
- [ ] Each new test is proven to bite: it fails against the pre-fix prompt/parser and
      passes after.
- [ ] `npm run ci` passes from the repo root, including `build.mjs --check` with the
      regenerated `plugin/` mirror committed alongside `core/`.
