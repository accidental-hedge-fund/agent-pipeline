## 1. Comment Filter Helper

- [ ] 1.1 Add `extractHumanPlanComments(comments: {author: string; body: string; createdAt: string}[], planCommentBody: string): {author: string; body: string}[]` to `core/scripts/gh.ts`
- [ ] 1.2 The function finds the most recent comment whose body starts with `## Implementation Plan` (the posted plan comment) and returns all later comments whose body does NOT begin with any known pipeline header
- [ ] 1.3 Define the known pipeline header prefixes as a module-level constant: `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review 1`, `## Review 2`, `## Fix 1`, `## Fix 2`
- [ ] 1.4 Return an empty array when no comments follow the plan comment

## 2. Re-fetch Comments at Revision Time

- [ ] 2.1 In `core/scripts/stages/planning.ts`, after `reviewResult` is received (line ~132), call `getIssueDetail()` again to obtain a fresh comment list
- [ ] 2.2 Call `extractHumanPlanComments()` on the fresh comments using the posted plan body as the anchor
- [ ] 2.3 Store the result as `humanComments`; if empty, proceed with the existing flow unchanged

## 3. Update Revision Prompt Template

- [ ] 3.1 In `core/scripts/prompts/plan_revision.md`, add a `{{human_feedback}}` section after the existing reviewer feedback section
- [ ] 3.2 Label it clearly: `Human comments on the plan (if any):\n{{human_feedback}}`
- [ ] 3.3 Ensure the wording instructs the implementer to address human feedback alongside reviewer feedback when present

## 4. Update `buildPlanRevisionPrompt`

- [ ] 4.1 In `core/scripts/prompts/index.ts`, add optional `humanFeedback?: string` to the params type of `buildPlanRevisionPrompt`
- [ ] 4.2 Replace `{{human_feedback}}` with the formatted human comments string when provided, or an empty string when absent
- [ ] 4.3 Format each human comment as: `@<author>: <body>` separated by blank lines

## 5. Update Revised-Plan Comment in `planning.ts`

- [ ] 5.1 When `humanComments` is non-empty, pass the formatted comments to `buildPlanRevisionPrompt` as `humanFeedback`
- [ ] 5.2 When `humanComments` is non-empty, append `**Human feedback from**: ${authors}` to the revised-plan comment header (where `authors` is a comma-separated list of `@login` values)
- [ ] 5.3 When `humanComments` is empty, the comment text is unchanged from today

## 6. Tests

- [ ] 6.1 Unit test: `extractHumanPlanComments` returns empty when all comments precede the plan comment
- [ ] 6.2 Unit test: `extractHumanPlanComments` returns empty when only pipeline-pattern comments follow the plan comment
- [ ] 6.3 Unit test: `extractHumanPlanComments` returns human comments that follow the plan comment and lack pipeline headers
- [ ] 6.4 Unit test: `extractHumanPlanComments` returns empty when no `## Implementation Plan` comment exists at all
- [ ] 6.5 Unit test: `buildPlanRevisionPrompt` omits the human feedback section when `humanFeedback` is undefined
- [ ] 6.6 Unit test: `buildPlanRevisionPrompt` includes formatted human comments when `humanFeedback` is provided
- [ ] 6.7 Unit test: revised-plan comment header includes `**Human feedback from**` line when `humanComments` is non-empty
- [ ] 6.8 Unit test: revised-plan comment header is unchanged when `humanComments` is empty

## 7. Validation

- [ ] 7.1 Run `pnpm test` — all tests pass
- [ ] 7.2 Verify that a dry-run invocation on an issue with no human comments produces output identical to the current behavior
