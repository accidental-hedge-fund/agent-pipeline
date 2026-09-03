## Context

See `proposal.md` for why.

Current wiring:

- Fresh OpenSpec authoring returns `promptPlanText` from `openspec.readChangeFile(wt, changeId, "proposal.md")` and `specContext` from `openspec.readSpecDeltas(wt, changeId)`.
- `resumePlanReview` (#870) skips `authorArtifact`, sets `promptPlanText` from `extractPlan(comments)`, and leaves `specContext` unset.
- `#1416` restores the closed-over `changeId` inside `validateArtifact` / `revalidateArtifact` before `validateItem`. That restore runs after `NEEDS_REVISION`, not before the first resume plan-review prompt.
- `buildPlanReviewPrompt` / `buildPlanRevisionPrompt` already take `plan` and `specContext`. OpenSpec `planReviewCwd` is already `wt.path`, so `design.md` / `tasks.md` are inspectable on disk without new prompt placeholders.
- `OpenspecPlanningHookInjects` already fakes `listChangeDirs` / `validateItem`. `PlanningPhaseHooks` already has optional OpenSpec-only methods (`planReviewCwd?`, `invokeRevision?`).

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: reuse `restoreChangeIdIfEmpty`, `readChangeFile`, and `readSpecDeltas`. Do not add a second discovery layer or comment parser.
- Bind `promptPlanText` / `specContext` from the worktree before the resume plan-review prompt, so later revision in that session uses the same locals.
- Keep tests hermetic with injected comments plus file reads.

**Non-Goals:**

- A required new `PlanningPhaseHooks` method, BlockerKind, recovery recipe, or durable change-id store.
- Re-running the planning harness on resume.
- New prompt placeholders for `design.md` / `tasks.md`.
- Wiring implementing-resume in this change. That path MAY call the same bind later.
- Train, merge-authority, or review-schema edits.
- Calling `revalidateArtifact` on resume solely to borrow its return shape, which would add a pre-review `validateItem` gate the issue does not ask for.

## Decisions

### D1 — Bind through an optional hooks method, implemented with existing readers

Add optional `bindResumePlanArtifacts?(wt)` on `PlanningPhaseHooks`. OpenSpec implements it. Freeform omits it. When present and successful, `runPlanningPhases` sets `promptPlanText` and `specContext` from the result before `buildPlanReviewPrompt`. When absent, comment text stays the plan (freeform).

The OpenSpec implementation SHALL:

1. Call the existing `restoreChangeIdIfEmpty` helper.
2. Read `proposal.md` with `readChangeFile` (same as `authorArtifact`).
3. Read spec deltas with `readSpecDeltas` (same as `authorArtifact`).
4. Return those strings. Keep `planComment` as the GitHub comment for human-feedback extraction.

Do not scrape `_OpenSpec change \`id\`` from the comment. Do not persist `changeId` in run-state JSON.

Alternative considered: restore and read inside `runPlanningPhases` at `resumePlanReview`. Rejected: the runner would learn OpenSpec identity, which #1416 already rejected.

Alternative considered: call `revalidateArtifact(wt, comment)` on resume to reuse its return shape. Rejected: that also runs `validateItem` before review and changes resume failure timing. Artifact binding is not a new validation gate.

Alternative considered: a new required hook. Rejected: unrequested interface. Optional methods already exist for OpenSpec-only resume/review differences.

### D2 — Non-singular OpenSpec resume blocks; freeform falls back to the comment

When `bindResumePlanArtifacts` fails restore, return the same `{ ok: false, tag: "openspec-invalid" }` named restore reason #1416 already uses. The runner `setBlocked`s at plan-review. Do not review the stale comment as if it were a living OpenSpec proposal.

Freeform has no bind method, so it keeps the comment. That is the allowed fallback.

Do not add a BlockerKind or `BLOCKER_RECIPES` entry.

### D3 — Missing `proposal.md` after a successful restore matches first-pass authoring

If restore chooses an id but `readChangeFile(..., "proposal.md")` returns null, use the same fallback string first-pass authoring uses (`"(proposal.md not found)"`) rather than silently substituting the GitHub comment. Empty spec deltas stay `""`, same as first-pass.

### D4 — Extend the existing hook inject bag for file reads

Add `readChangeFile` and `readSpecDeltas` to `OpenspecPlanningHookInjects`, defaulting to `openspec.readChangeFile` / `openspec.readSpecDeltas`. Tests pass fakes. Production stays on the module functions.

Do not add live filesystem to unit tests. Do not merge this bag with `RunPlanningPhasesDeps.listChangeDirs` in this change.

### D5 — Class coverage, not implementing-resume wiring

The reusable bind (restore + file readers, optional hook) is the class fix for skipped-author OpenSpec plan text. Implementing-resume that still copies the comment is a sibling site. Empty-name restore (#1416) plus this bind are the shared pieces that later caller can use without a new mole for "stale comment vs living proposal".

### D6 — No prompt-template or review-schema edits

`buildPlanReviewPrompt` / `buildPlanRevisionPrompt` already accept `plan` and `specContext`. Fill those fields. Do not add a "posted comment (history)" section. `planReviewCwd` already points at the worktree, so `design.md` / `tasks.md` remain living files the reviewer can read.

## Risks / Trade-offs

- **[Risk]** Operator-committed worktree pins can differ from the posted comment. Reviewers may still ask for comment-only wording.
  → Mitigation: the prompt plan text is the worktree proposal. That is the required source of truth. Do not also paste the stale comment as plan text.

- **[Risk]** `beforeList` comes from `cfg.repo_dir`. Shared multi-change trees still fail singularity, as in #1416.
  → Mitigation: keep the singularity contract. Block rather than pick an arbitrary id.

- **[Risk]** Optional-hook duck-typing can drift if a test hand-builds OpenSpec-shaped hooks without the bind.
  → Mitigation: the concrete `makeOpenspecPlanningHooks` regression is the bite. Hand-built hooks without the method keep comment behavior, which is the freeform fallback.

- **[Risk]** Inject-at-construction can drift from `RunPlanningPhasesDeps`.
  → Mitigation: accepted for this cut, same as #1416. Unifying the seams is extra scope.

## Migration Plan

No schema, label, or CLI migration. Ship in the engine. Existing OpenSpec plan-review resume starts binding worktree files on the next run.

Rollback: revert the optional bind and the resume-branch call. No durable state to unwind.

## Open Questions

None. Implementing-resume reuse is deferred by design (D5), not an open product question.
