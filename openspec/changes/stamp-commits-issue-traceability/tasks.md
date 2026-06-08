## 1. Run ID Generation

- [x] 1.1 Add `pipelineRunId` generation in the pipeline orchestrator entry point (format: `<issueNumber>/<UTC-ISO-timestamp>`), generated once per dispatch before any stage is called
- [x] 1.2 Thread `pipelineRunId` as a parameter through stage function signatures that create commits (`planning.ts`, `pre_merge.ts`)

## 2. Direct Pipeline Commits — Trailers

- [x] 2.1 Update the docs-update empty-marker commit in `pre_merge.ts` to append `\n\nIssue: #${issueNumber}\nPipeline-Run: ${pipelineRunId}` to the commit message
- [x] 2.2 Update the docs-update change commit in `pre_merge.ts` to append the same trailers
- [x] 2.3 Update the openspec-archive commit in `pre_merge.ts` to append the trailers
- [x] 2.4 Update the openspec-init commit in `planning.ts` to append the trailers

## 3. Prompt Templates — Trailer Instructions

- [x] 3.1 Add `pipeline_run_id` as a template variable to `buildImplementingPrompt` in `prompts/index.ts`; update `implementing.md` to include the trailer instruction using `{{issue_number}}` and `{{pipeline_run_id}}`
- [x] 3.2 Add `pipeline_run_id` as a template variable to `buildFixPrompt` in `prompts/index.ts`; update `fix.md` to include the trailer instruction
- [x] 3.3 Add `pipeline_run_id` as a template variable to `buildTestFixPrompt` in `prompts/index.ts`; update `test_fix.md` to include the trailer instruction
- [x] 3.4 Update all call sites of `buildImplementingPrompt`, `buildFixPrompt`, and `buildTestFixPrompt` to pass `pipelineRunId`

## 4. Tests

- [x] 4.1 Add unit tests for direct pipeline commits verifying that the message string contains `Issue: #<n>` and `Pipeline-Run: <id>` trailers
- [x] 4.2 Add a test asserting the `pipelineRunId` format matches `<number>/<YYYY-MM-DDTHH:MM:SSZ>`
- [x] 4.3 Add tests for each updated prompt builder asserting the rendered output includes the trailer instruction lines with correct placeholder substitution

## 5. Validation

- [x] 5.1 Run `pnpm test` and confirm all new and existing tests pass
- [x] 5.2 Manually verify a commit from a local pipeline run using `git log --format="%(trailers:key=Issue,key=Pipeline-Run)" -1` and confirm both trailers are present
