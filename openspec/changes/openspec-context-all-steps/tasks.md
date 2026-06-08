## 1. Extract openspecContext helper

- [x] 1.1 Move the `openspecContext(cfg, cwd)` function from `stages/review.ts` into `openspec.ts` and export it
- [x] 1.2 Update the import in `stages/review.ts` to use the exported function from `openspec.ts`
- [x] 1.3 Verify existing review-round behavior is unchanged (spec deltas still injected; no regression)

## 2. Wire spec context into planning stage

- [x] 2.1 In `stages/planning.ts`, call `openspecContext(cfg, cwd)` and pass the result to `buildPlanReviewPrompt` as `specContext`
- [x] 2.2 In `stages/planning.ts`, pass `specContext` to `buildPlanRevisionPrompt`
- [x] 2.3 In `stages/planning.ts`, pass `specContext` to `buildImplementingPrompt` (both freeform and OpenSpec flows)

## 3. Wire spec context into fix stage

- [x] 3.1 In `stages/fix.ts`, call `openspecContext(cfg, cwd)` and pass the result to `buildFixPrompt` as `specContext`

## 4. Update prompt builders

- [x] 4.1 Add optional `specContext?: string` parameter to `buildPlanReviewPrompt`
- [x] 4.2 Add optional `specContext?: string` parameter to `buildPlanRevisionPrompt`
- [x] 4.3 Add optional `specContext?: string` parameter to `buildImplementingPrompt`
- [x] 4.4 Add optional `specContext?: string` parameter to `buildFixPrompt`

## 5. Update prompt templates

- [x] 5.1 Add a conditional `{{spec_context}}` section to `plan_review.md`
- [x] 5.2 Add a conditional `{{spec_context}}` section to `plan_revision.md`
- [x] 5.3 Add a conditional `{{spec_context}}` section to `implementing.md`
- [x] 5.4 Add a conditional `{{spec_context}}` section to `fix.md`

## 6. Verify correctness

- [x] 6.1 Run `pnpm test` — all tests pass
- [x] 6.2 Confirm non-OpenSpec run: none of the updated prompt templates include a spec section (empty string elision)
- [x] 6.3 Confirm OpenSpec run: plan-review, plan-revision, implementing, and fix prompts each contain the spec deltas
