## Why

The pipeline uses only the issue body as its primary source of product intent, leaving important human discussion in issue comments invisible to planning, review, and shipcheck. When maintainers clarify scope, contradict the body, or add design constraints in comments, the pipeline silently ignores them—producing plans and reviews against the original (potentially stale or incomplete) intent.

## What Changes

- Add a pre-planning context-collection step: fetch issue comments, classify them as human versus pipeline-authored using header matching, and build a bounded `issue-context-snapshot` from the human comments.
- Post the snapshot as a `## Pre-Planning Context` comment on the issue before the planning harness is invoked, making the artifact visible and auditable.
- Thread the snapshot through planning, plan-review, review, and shipcheck stage prompts via a `{{context_snapshot}}` placeholder; suppress it from fix-round prompts which stay focused on specific review findings.
- Add lightweight conflict detection: when the issue body and human-comment snapshot disagree on named entities, explicit scope constraints, or direct negations, the pipeline surfaces the conflict as a warning in the planning and plan-review step rather than silently blending the sources.
- Classify new human comments posted after the revised plan as unacknowledged new input; surface them as requiring explicit re-plan or override rather than silently injecting them into implementation or review context.

## Capabilities

### New Capabilities
- `issue-context-snapshot`: Pre-planning collection and classification of human vs. pipeline-authored issue comments, construction of a bounded snapshot artifact, posting the snapshot as a visible `## Pre-Planning Context` comment, stage-specific consumption rules (planning/plan-review/review/shipcheck receive it; fix rounds do not), conflict detection between body and snapshot, and post-revised-plan new-comment acknowledgement gate.

### Modified Capabilities
- `human-plan-feedback`: Add the post-revised-plan new-comment acknowledgement path — human comments posted after the revised plan SHALL be detected and surfaced as requiring re-plan or explicit override rather than silently folded into implementation prompts.

## Impact

- `core/scripts/stages/planning.ts` — pre-planning context collection, snapshot construction, conflict-detection logic, snapshot injection into planning prompt, posting the `## Pre-Planning Context` comment.
- `core/scripts/prompts/planning.md`, `core/scripts/prompts/plan-review.md`, `core/scripts/prompts/review.md`, `core/scripts/prompts/shipcheck.md` (if applicable) — new `{{context_snapshot}}` placeholder; placeholder is omitted (not rendered) for fix-round prompts.
- `core/scripts/gh.ts` — comment classification utility (`classifyComment(body: string): 'human' | 'pipeline'`) using the pipeline-header set already established in `human-plan-feedback`.
- `core/scripts/stages/fix.ts` — ensure fix-round prompt construction does NOT inject the context snapshot.
- `core/test/issue-context-snapshot.test.ts` — new unit-test file covering: comment classification, snapshot builder, size bounding, conflict detector, post-revised-plan new-comment detector.
- `plugin/` mirror — regenerated after any `core/` change.

## Acceptance Criteria

- [ ] When an issue first enters the pipeline, the planning prompt includes the issue title/body plus relevant pre-pipeline human comments, bounded by a documented character limit (default: 8 000 characters across all human comment bodies).
- [ ] Human comments in the snapshot are fenced or labeled to signal untrusted input; model prompts cannot treat commenter text as operational instructions.
- [ ] Pipeline-authored comments (`## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review N`, `## Fix N`, `## Pipeline:`, `## Pre-Planning Context`) are excluded from the snapshot.
- [ ] The pipeline posts a `## Pre-Planning Context` comment before the planning harness runs; the comment lists every human comment included in the snapshot with author and ISO-8601 timestamp.
- [ ] Planning, plan-review, review, and shipcheck prompts receive the snapshot via `{{context_snapshot}}`; fix-round prompts do not include the snapshot.
- [ ] When the issue body and the snapshot contain an explicit conflict (named-entity mismatch or direct negation of scope), the pipeline surfaces a conflict warning in the planning or plan-review output.
- [ ] Human comments posted after the revised plan are detected and flagged as unacknowledged new input; they are NOT silently injected into subsequent implementation or fix-round prompts.
- [ ] All new logic is covered by unit tests using injectable deps (no real network, git, or subprocess in tests).
- [ ] `npm run ci` passes end-to-end after the change.
