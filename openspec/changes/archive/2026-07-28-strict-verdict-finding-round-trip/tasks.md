## 1. Prove the bug first (red)

- [x] 1.1 Add a failing test in `core/test/review.test.ts`: a delegated-shape verdict JSON whose single finding carries `prior_round_acknowledgment` and `rejected_alternatives` → `parseStrictVerdict` currently returns them as `undefined`
- [x] 1.2 Add a failing manifest-driven test asserting `parseStrictVerdict` round-trips every name in `REVIEW_SCHEMA_FIELDS.finding`; confirm it fails naming the two missing fields
- [x] 1.3 Record the red output (which fields were dropped) so the bite proof is verifiable in review

## 2. Single-source the finding field projection

- [x] 2.1 In `core/scripts/stages/review-parsing.ts`, factor the per-field reconstruction out of `validateStrictFinding` into one projection helper that copies every field declared on `ReviewFinding` / named in `REVIEW_SCHEMA_FIELDS.finding`
- [x] 2.2 Include `prior_round_acknowledgment` and `rejected_alternatives` in the projection
- [x] 2.3 Keep `validateStrictFinding` as the type-validating wrapper: required fields present + correctly typed, optional fields correctly typed when present, then project; return `null` on any mismatch
- [x] 2.4 Add strict type checks for the two new fields — `prior_round_acknowledgment` must be a `string`; `rejected_alternatives` must be an array of `string` — rejecting the finding otherwise (fail closed, matching `isValidBlockingFindings`)
- [x] 2.5 Route `parseStructuredVerdict`'s findings through the same projection **without** the rejection policy, so a partial/legacy finding still flows through as it does today

## 3. Lock the contract with drift guards

- [x] 3.1 Turn 1.2 into the permanent finding-level drift guard, iterating `REVIEW_SCHEMA_FIELDS.finding` and asserting each field survives `parseStrictVerdict` with its sentinel value
- [x] 3.2 Assert the same manifest against `parseStructuredVerdict`, so the two parsers cannot diverge on carried fields
- [x] 3.3 Make the sample finding type-correct per field (valid `severity`, numeric `confidence` in `[0,1]`, numeric line bounds, boolean `blocking`, literal `spec_divergence_direction`, string-array `rejected_alternatives`) and assert the verdict parsed with exactly one finding before checking fields — so the guard can never pass vacuously
- [x] 3.4 Make an unmapped new finding field fail the guard loudly rather than be skipped
- [x] 3.5 Add negative tests: non-string `prior_round_acknowledgment` → `parseStrictVerdict` returns `null`; `rejected_alternatives` containing a non-string → returns `null`
- [x] 3.6 Add a backward-compat test: a verdict whose finding omits both fields parses on both paths with both fields absent

## 4. Prove the fields reach the guards, not just the parser

- [x] 4.1 Add a test exercising the settled-finding reversal guard with a finding parsed by `parseStrictVerdict`: settled surface + non-empty `prior_round_acknowledgment` → NOT demoted with reason `reversal-unacknowledged`
- [x] 4.2 Add the mirror case: same settled surface with the acknowledgment absent → still demoted (guard semantics unchanged by this change)
- [x] 4.3 Confirm `rejected_alternatives` parsed on the delegated path reaches the durable `blockingFindings` artifact entry (`rejectedAlternatives`) for the prior-round digest

## 5. Verify and finalize

- [x] 5.1 Confirm all pre-existing `parseStructuredVerdict` tests (prose fallback, partial JSON defaulting, Codex prose review, #56 verdict drift guard) pass unmodified
- [x] 5.2 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` together with `core/`
- [x] 5.3 Run `npm run ci` from the repo root; treat red as not-done
- [x] 5.4 Confirm `openspec validate --all` passes as part of `ci:openspec`
