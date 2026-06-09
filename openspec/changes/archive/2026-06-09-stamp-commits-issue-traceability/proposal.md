## Why

Every commit the pipeline creates today carries only a human-readable message; there is no machine-parseable link back to the originating GitHub issue or pipeline run. This makes it impossible to reliably grep a git log for "all work produced by pipeline run X for issue #42" — a hard requirement for post-incident audits, metrics, and downstream automation.

## What Changes

- **All direct pipeline commits** (docs-update, openspec-archive, openspec-init) gain two structured git trailers appended to their commit messages.
- **All harness-instructed commits** (implementing, fix, test-fix rounds) have their prompt templates updated to require the same trailers.
- **A `pipelineRunId` is generated** once at pipeline invocation and threaded through to every commit operation, giving all commits from a single run the same `Pipeline-Run:` value.

## Capabilities

### New Capabilities

- `commit-traceability-trailers`: Defines the trailer format, which commits it applies to, how the run ID is derived, and the consistency guarantee across a pipeline run.

### Modified Capabilities

(none — no existing spec-level requirements change)

## Impact

- `core/scripts/stages/pre_merge.ts` — adds trailers to docs-update and openspec-archive commits
- `core/scripts/stages/planning.ts` — adds trailers to openspec-init commit; threads run ID to implementing harness
- `core/scripts/prompts/implementing.md`, `fix.md`, `test_fix.md` — updated to require trailers in harness-generated commits
- `core/scripts/prompts/index.ts` — `buildImplementingPrompt`, `buildFixPrompt`, `buildTestFixPrompt` receive `pipeline_run_id` template var
- `core/scripts/pipeline.ts` (or equivalent orchestrator) — generates `pipelineRunId` at invocation time
- No new external dependencies; `git commit --trailer` is available since git 2.15 (already required by the platform)
