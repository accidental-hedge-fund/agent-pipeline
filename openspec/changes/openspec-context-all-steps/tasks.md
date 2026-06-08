## 1. Extract openspecContext helper

- [ ] 1.1 Move the `openspecContext(cfg, cwd)` function from `stages/review.ts` into `openspec.ts` and export it
- [ ] 1.2 Update the import in `stages/review.ts` to use the exported function from `openspec.ts`
- [ ] 1.3 Verify existing review-round behavior is unchanged (spec deltas still injected; no regression)

## 2. Wire spec context into planning stage

- [ ] 2.1 In `stages/planning.ts`, call `openspecContext(cfg, cwd)` and pass the result to `buildPlanReviewPrompt` as `specContext`
- [ ] 2.2 In `stages/planning.ts`, pass `specContext` to `buildPlanRevisionPrompt`
- [ ] 2.3 In `stages/planning.ts`, pass `specContext` to `buildImplementingPrompt` (both freeform and OpenSpec flows)

## 3. Wire spec context into fix stage

- [ ] 3.1 In `stages/fix.ts`, call `openspecContext(cfg, cwd)` and pass the result to `buildFixPrompt` as `specContext`

## 4. Update prompt builders

- [ ] 4.1 Add optional `specContext?: string` parameter to `buildPlanReviewPrompt`
- [ ] 4.2 Add optional `specContext?: string` parameter to `buildPlanRevisionPrompt`
- [ ] 4.3 Add optional `specContext?: string` parameter to `buildImplementingPrompt`
- [ ] 4.4 Add optional `specContext?: string` parameter to `buildFixPrompt`

## 5. Update prompt templates

- [ ] 5.1 Add a conditional `{{spec_context}}` section to `plan_review.md`
- [ ] 5.2 Add a conditional `{{spec_context}}` section to `plan_revision.md`
- [ ] 5.3 Add a conditional `{{spec_context}}` section to `implementing.md`
- [ ] 5.4 Add a conditional `{{spec_context}}` section to `fix.md`

## 6. Verify correctness

- [ ] 6.1 Run `pnpm test` — all tests pass
- [ ] 6.2 Confirm non-OpenSpec run: none of the updated prompt templates include a spec section (empty string elision)
- [ ] 6.3 Confirm OpenSpec run: plan-review, plan-revision, implementing, and fix prompts each contain the spec deltas
