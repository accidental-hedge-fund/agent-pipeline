## 1. Define the schema constant

- [ ] 1.1 Export `REVIEW_VERDICT_SCHEMA_BLOCK` (a template string matching the current hand-written JSON block) from `core/scripts/types.ts` or a new `core/scripts/review-schema.ts`
- [ ] 1.2 Export a companion `REVIEW_SCHEMA_FIELDS` metadata object (or equivalent) that enumerates the field names of `ReviewFinding` and `ReviewVerdict` for use by the drift guard test

## 2. Wire the constant into the prompt builder

- [ ] 2.1 Locate (or create) the prompt-building function that loads `review_standard.md` and `review_adversarial.md` (likely in `core/scripts/review.ts` or `core/scripts/prompts/`)
- [ ] 2.2 Replace the hand-copied JSON block in `review_standard.md` with `{{schema_block}}`
- [ ] 2.3 Replace the hand-copied JSON block in `review_adversarial.md` with `{{schema_block}}`
- [ ] 2.4 Update the prompt-building function to substitute `{{schema_block}}` with `REVIEW_VERDICT_SCHEMA_BLOCK` before returning the assembled prompt
- [ ] 2.5 Add a hard throw if the assembled prompt still contains a literal `{{schema_block}}` token after substitution

## 3. Write the drift guard test

- [ ] 3.1 Create `core/scripts/review-schema.test.ts` (co-located with the schema constant)
- [ ] 3.2 Implement a test that extracts field names from `REVIEW_SCHEMA_FIELDS` and asserts they match the fields enumerated in `REVIEW_VERDICT_SCHEMA_BLOCK` — fails with a clear diff on mismatch
- [ ] 3.3 Implement a test that calls the prompt-building function for both `review_standard.md` and `review_adversarial.md` and asserts the output contains no literal `{{schema_block}}` token and does contain each expected field name

## 4. Verify and validate

- [ ] 4.1 Run `pnpm test` and confirm all existing tests pass and the new drift guard tests pass
- [ ] 4.2 Manually verify the rendered prompt text contains the correct schema block (spot-check against the previous hand-written form)
- [ ] 4.3 Simulate drift: temporarily rename a field in `REVIEW_VERDICT_SCHEMA_BLOCK` without updating `ReviewFinding`, confirm the drift guard test fails; revert
