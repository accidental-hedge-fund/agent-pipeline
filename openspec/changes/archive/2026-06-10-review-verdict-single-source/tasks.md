## 1. Define the schema constant

- [x] 1.1 Export `REVIEW_VERDICT_SCHEMA_BLOCK` (a template string matching the current hand-written JSON block) from `core/scripts/types.ts` or a new `core/scripts/review-schema.ts`
- [x] 1.2 Export a companion `REVIEW_SCHEMA_FIELDS` metadata object (or equivalent) that enumerates the field names of `ReviewFinding` and `ReviewVerdict` for use by the drift guard test

## 2. Wire the constant into the prompt builder

- [x] 2.1 Locate (or create) the prompt-building function that loads `review_standard.md` and `review_adversarial.md` (likely in `core/scripts/review.ts` or `core/scripts/prompts/`)
- [x] 2.2 Replace the hand-copied JSON block in `review_standard.md` with `{{schema_block}}`
- [x] 2.3 Replace the hand-copied JSON block in `review_adversarial.md` with `{{schema_block}}`
- [x] 2.4 Update the prompt-building function to substitute `{{schema_block}}` with `REVIEW_VERDICT_SCHEMA_BLOCK` before returning the assembled prompt
- [x] 2.5 Add a hard throw if the assembled prompt still contains a literal `{{schema_block}}` token after substitution — satisfied by the existing `substitute()` guard in `prompts/index.ts`, which throws `Unfilled prompt placeholder(s) {{schema_block}}` when the key is not supplied (regression-tested in `review-schema.test.ts`)

## 3. Write the drift guard test

- [x] 3.1 Create the drift guard test co-located with the suite (`core/test/review-schema.test.ts` — the runner glob is `test/*.test.ts`, so a `core/scripts/*.test.ts` file would never execute)
- [x] 3.2 Implement a test that extracts field names from `REVIEW_SCHEMA_FIELDS` and asserts they match the fields enumerated in `REVIEW_VERDICT_SCHEMA_BLOCK` — fails with a clear diff on mismatch
- [x] 3.3 Implement a test that calls the prompt-building function for both `review_standard.md` and `review_adversarial.md` and asserts the output contains no literal `{{schema_block}}` token and does contain each expected field name

## 4. Verify and validate

- [x] 4.1 Run `pnpm test` and confirm all existing tests pass and the new drift guard tests pass (core: 416 pass; root: 70 pass)
- [x] 4.2 Manually verify the rendered prompt text contains the correct schema block (spot-check against the previous hand-written form — byte-identical)
- [x] 4.3 Simulate drift: temporarily rename a field in `REVIEW_VERDICT_SCHEMA_BLOCK` without updating `ReviewFinding`, confirm the drift guard test fails; revert
