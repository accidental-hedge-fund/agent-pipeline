## 1. Prove the bug first (red)

- [ ] 1.1 Add a failing test asserting `materializeStagePrompt("review", fixture)` contains `REVIEW_VERDICT_SCHEMA_BLOCK` — confirm it fails today
- [ ] 1.2 Add a failing test feeding a fenced ```json verdict (with prose around it) to the review-findings capture → `detail.findings` is currently `undefined`
- [ ] 1.3 Add a failing end-to-end `review`-cell test (fake harness emits a valid verdict naming the fixture's seeded defect) asserting `gradeReview` returns `true_positives > 0` — confirm it currently reports every defect as a false negative
- [ ] 1.4 Record the red output so the bite proof is verifiable in review

## 2. Carry the production verdict contract into the review-mode prompt

- [ ] 2.1 In `core/scripts/evals/stage-adapters.ts`, import `REVIEW_VERDICT_SCHEMA_BLOCK` from `core/scripts/review-schema.ts`
- [ ] 2.2 Add a per-stage output-contract suffix, populated for the `review` stage only, containing the schema block plus a JSON-only instruction matching production's wording
- [ ] 2.3 Leave the four existing prompt parts and all other stages' materialization untouched
- [ ] 2.4 Confirm the materialized prompt contains no unsubstituted `{{…}}` placeholder token

## 3. Parse review output with the production parser

- [ ] 3.1 In `core/scripts/evals/executor.ts`, replace `parseReviewFindings`'s bespoke `JSON.parse(stdout)` with `parseStrictVerdict` → `parseStructuredVerdict` (strict-then-tolerant, design D2)
- [ ] 3.2 Return both the findings and a parse-provenance value (`strict` | `tolerant` | `unparseable`)
- [ ] 3.3 Ensure the prose/text fallback of `parseStructuredVerdict` is classified `unparseable`, never as a verdict with zero findings
- [ ] 3.4 Record `detail.review_verdict_parse` on every completed `review`-stage cell, on both the local-CLI stage loop and the API/model-endpoint path
- [ ] 3.5 Keep `detail.findings` absent (not `[]`) when the output is unparseable, so `parseReportedFindings` behavior is unchanged for that case
- [ ] 3.6 Declare the provenance value's type in `core/scripts/evals/types.ts` if the detail shape is typed there

## 4. Lock the contract with drift guards

- [ ] 4.1 Turn 1.1 into a permanent drift guard asserting the review prompt embeds the exact `REVIEW_VERDICT_SCHEMA_BLOCK` text, derived from the constant
- [ ] 4.2 Add a guard asserting `planning`, `plan-review`, `implementing`, `fix`, and `shipcheck` prompts are byte-identical to their pre-change materialization
- [ ] 4.3 Add a parse test matrix: bare JSON verdict, fenced verdict with prose, inline verdict object, prose-only, empty stdout — asserting findings + provenance for each
- [ ] 4.4 Assert a parsed eval finding retains the fields `parseReportedFindings` requires (`file`, `line_start`, `line_end`, `severity`) plus the other declared `REVIEW_SCHEMA_FIELDS.finding` fields the harness emitted

## 5. Prove the output reaches the grader

- [ ] 5.1 End-to-end `review` cell (fake harness, no network) emitting a valid verdict matching the fixture's seeded defect → `ReviewGrade` with `true_positives > 0` and `recall === 1`
- [ ] 5.2 Mirror case: fake harness emits prose → cell is `completed` with `review_verdict_parse: "unparseable"`, `detail.findings` absent, and the grade reports the seeded defects as false negatives
- [ ] 5.3 Confirm a `review` stage inside an `end-to-end` cell receives the same contract-bearing prompt and capture path

## 6. Verify and finalize

- [ ] 6.1 Confirm pre-existing evals executor / run / grading tests pass unmodified
- [ ] 6.2 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` together with `core/`
- [ ] 6.3 Run `npm run ci` from the repo root; treat red as not-done
- [ ] 6.4 Confirm `openspec validate --all` passes as part of `ci:openspec`
