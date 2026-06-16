## 1. Config — approval_checkpoints field

- [x] 1.1 Add `approval_checkpoints` zod field to `PartialConfigSchema` in `core/scripts/config.ts`: optional array of strings, validated against `STAGES` with `"backlog"` and `"ready-to-deploy"` excluded; default `[]`
- [x] 1.2 Add `approvalCheckpoints: string[]` to the `Config` type and `DEFAULT_CONFIG` (default `[]`)
- [x] 1.3 Write unit tests for `resolveConfig()` covering: absent key → `[]`, valid stage names accepted, unknown stage name rejected, `"backlog"` rejected, `"ready-to-deploy"` rejected

## 2. GH helpers — awaiting-approval label

- [x] 2.1 Add `applyAwaitingApprovalLabel(issue, deps)` and `removeAwaitingApprovalLabel(issue, deps)` helpers in `core/scripts/gh.ts`, reusing existing label add/remove wrappers
- [x] 2.2 Export the label constant `AWAITING_APPROVAL_LABEL = "pipeline:awaiting-approval"` from `core/scripts/types.ts`

## 3. Checkpoint logic — pure helpers

- [x] 3.1 Create `core/scripts/stages/checkpoint.ts` with a pure `findCheckpointComment(comments: IssueComment[]): IssueComment | null` helper that returns the most recent `## Pipeline: Awaiting Approval` comment
- [x] 3.2 Add `extractCheckpointSha(comment: IssueComment): string | null` that parses the `<!-- checkpoint-sha: <sha> -->` sentinel
- [x] 3.3 Add `buildCheckpointComment(stage: string, headSha: string, notice?: string): string` that renders the full comment body including the sentinel and "### How to approve" section
- [x] 3.4 Write unit tests for all three pure helpers (no network/git calls)

## 4. Advance loop — checkpoint gate

- [x] 4.1 In `core/scripts/pipeline.ts` advance loop, add a `checkApprovalCheckpoint(stage, issue, config, headSha, deps)` call before each stage dispatch; implement the three-branch logic: (a) not in `approvalCheckpoints` → no-op, (b) label absent → post checkpoint comment + apply label + return `waiting`, (c) label present + SHA matches → return `waiting`, (d) label present + SHA stale → post updated comment + return `waiting`
- [x] 4.2 Ensure the advance loop surfaces a clear log line when stopping at a checkpoint (`[pipeline] #N: checkpoint awaiting approval at stage <X>`)
- [x] 4.3 Write unit tests for `checkApprovalCheckpoint` covering all four branches using `deps` fakes (no real GH/git calls)

## 5. Integration test

- [x] 5.1 Add an integration-level test in `core/test/` that exercises a full advance-loop tick with `approvalCheckpoints: ["implementing"]`: verify the loop stops at `implementing`, the checkpoint comment is posted, and the label is applied
- [x] 5.2 Add a second test showing that re-invoking with the label absent dispatches `implementing` normally

## 6. Plugin mirror + CI

- [x] 6.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`; confirm no diff errors
- [x] 6.2 Run `npm run ci` from the repo root; all tests must pass before marking done
