## Why

When a repo uses OpenSpec, the pipeline writes intended behavior down as a change (proposal, tasks, spec deltas) before any code is written — but today only the review rounds actually receive those spec documents in context. Plan-review, plan-revision, implementing, and fix rounds all reason about or produce work for the change without ever seeing the spec they're supposed to satisfy, so the work can drift from intent before review ever catches it.

## What Changes

- The `openspecContext()` helper (currently private to `review.ts`) is extracted to `openspec.ts` so all stages can call it without duplication.
- `buildPlanReviewPrompt`, `buildPlanRevisionPrompt`, `buildImplementingPrompt`, and `buildFixPrompt` each gain an optional `specContext` parameter.
- The corresponding prompt templates (`plan_review.md`, `plan_revision.md`, `implementing.md`, `fix.md`) each gain a `{{spec_context}}` section that is rendered only when non-empty.
- The stage orchestration code in `planning.ts` and `fix.ts` loads `openspecContext()` and passes it through to each prompt builder when OpenSpec is active.
- Non-OpenSpec runs: `openspecContext()` returns `""`, no template section is rendered, behavior is identical to today.
- Review rounds: unchanged — they already have spec context; no duplication, no regression.
- Purely mechanical steps (CI gate, mergeability check, pre-merge spec validate/archive, docs-update) are not affected.

## Capabilities

### New Capabilities

- `openspec-context-propagation`: Every harness step that reasons about or produces work for a change — plan-review, plan-revision, implementing, and fix rounds — receives the change's spec deltas in its prompt context when OpenSpec is active.

### Modified Capabilities

_(none — no existing capability spec-level requirements are changing)_

## Impact

- **Files changed**: `plugin/pipeline/skills/pipeline/core/scripts/openspec.ts` (extract helper), `stages/planning.ts` (load and pass spec context), `stages/fix.ts` (load and pass spec context), prompt templates `plan_review.md`, `plan_revision.md`, `implementing.md`, `fix.md`.
- **No API surface changes** — all modifications are internal to the pipeline skill.
- **No breaking changes** — the new `specContext` parameters are optional/defaulted; non-OpenSpec runs are unaffected.
