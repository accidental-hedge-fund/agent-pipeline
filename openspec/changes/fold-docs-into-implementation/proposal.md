## Why

The pre-merge docs step runs an LLM call *after* both reviews pass, commits changes the reviewers never saw, and then returns `waiting` — forcing a second full CI cycle (up to 900 s). Folding the docs instruction into the implementation step makes docs part of the reviewed diff, eliminates the unreviewed-commit gap, and cuts the happy path by one LLM call and one CI cycle.

## What Changes

- The implementing prompt gains a conditional docs paragraph when `cfg.steps.docs` is `true`, instructing the implementer to update affected docs (README, CLAUDE.md, config docs, etc.) in the same change.
- `updateDocs`, `docsAlreadyUpdated`, `enforceDocsOnlyGate`, and `enforceDocsCommitMessageGate` are deleted from `pre_merge.ts`; the "docs pushed; CI needs to re-run" `waiting` branch is removed.
- `docs_update.md` prompt template and `buildDocsUpdatePrompt` are deleted from `prompts/`.
- `DOCS_COMMIT_PREFIX` constant and the docs-commit branch of `isPipelineInternalCommit` are deleted (`pre_merge.ts:38,50-55`); only the `OPENSPEC_ARCHIVE_PREFIX` exemption survives.
- `steps.docs` key is retained in `PipelineConfig` and the strict schema; its meaning shifts from "run a docs harness in pre-merge" to "include the docs instruction in the implementing prompt".
- `pre-merge-docs.test.ts` is replaced with a pre-merge cycle-count test that asserts the happy path visits CI exactly once; the docs-gate tests are removed (the gate no longer exists).

## Capabilities

### New Capabilities
<!-- none — this change removes a step; it introduces no new capability boundary -->

### Modified Capabilities
- `configurable-steps`: `steps.docs` semantics shift — on now adds docs instruction to implementing prompt rather than invoking a pre-merge harness; the "docs disabled → pre-merge skips harness" scenario is replaced with "docs enabled → implementing prompt includes docs instruction".
- `review-sha-gating`: The pipeline-internal-commit exemption for docs commits (`DOCS_COMMIT_PREFIX`) becomes dead and is removed; `isPipelineInternalCommit` covers only OpenSpec archive commits going forward.

## Impact

- `core/scripts/stages/pre_merge.ts` — remove docs step (lines 38–55, 98–110, 320–461).
- `core/scripts/prompts/docs_update.md` — delete.
- `core/scripts/prompts/index.ts` — delete `buildDocsUpdatePrompt` and its `BuildDocsArgs` interface.
- `core/scripts/prompts/implementing.md` — add conditional docs instruction section.
- `core/scripts/prompts/index.ts` (`buildImplementingPrompt`) — pass `steps.docs` to the implementing prompt substitution.
- `core/test/pre-merge-docs.test.ts` — replace with single-CI-cycle pre-merge test.
- `plugin/` mirror — regenerate to stay in sync with core.
