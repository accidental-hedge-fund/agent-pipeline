## Context

See `proposal.md` for why.

Current wiring:

- Fresh OpenSpec authoring returns `promptPlanText` from `openspec.readChangeFile(wt, changeId, "proposal.md")` and `specContext` from `openspec.readSpecDeltas(wt, changeId)`.
- `resumePlanReview` (#870) skips `authorArtifact`, sets `promptPlanText` from `extractPlan(comments)`, and leaves `specContext` unset.
- `#1416` restores the closed-over `changeId` inside `validateArtifact` / `revalidateArtifact` before `validateItem`. That restore runs after `NEEDS_REVISION`, not before the first resume plan-review prompt.
- `restoreChangeIdIfEmpty` returns `{ ok: true }` when `changeId` is already non-empty. It does not check that that id still has a readable `proposal.md`.
- `buildPlanReviewPrompt` / `buildPlanRevisionPrompt` already take `plan` and `specContext`. OpenSpec `planReviewCwd` is already `wt.path`, so `design.md` / `tasks.md` are inspectable on disk without new prompt placeholders.
- `readSpecDeltas` concatenates only `openspec/changes/<id>/specs/**/*.md`. It returns `""` when that tree is missing. It does not read `design.md` or `tasks.md`.
- `OpenspecPlanningHookInjects` already fakes `listChangeDirs` / `validateItem`. `PlanningPhaseHooks` already has optional OpenSpec-only methods (`planReviewCwd?`, `invokeRevision?`).

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope code: reuse `restoreChangeIdIfEmpty`, `readChangeFile`, and `readSpecDeltas`. Do not add a second discovery layer or comment parser.
- One resolved-change flow: restore `changeId` when empty, then bind files from that resolved id before the resume plan-review prompt, so later revision in that session uses the same locals.
- Fail closed when the resolved id has no readable `proposal.md`. Do not fall back to the GitHub comment.
- Keep tests hermetic with injected comments plus file reads.

**Non-Goals:**

- A required new `PlanningPhaseHooks` method, BlockerKind, recovery recipe, or durable change-id store.
- Re-running the planning harness on resume.
- New prompt placeholders for `design.md` / `tasks.md`.
- Wiring implementing-resume in this change. That path MAY call the same bind later.
- Train, merge-authority, or review-schema edits.
- Calling `revalidateArtifact` on resume solely to borrow its return shape, which would add a pre-review `validateItem` gate the issue does not ask for.
- Changing first-pass authoring's `"(proposal.md not found)"` placeholder.

## Decisions

### D1 — Bind through an optional hooks method, implemented with existing readers

Add optional `bindResumePlanArtifacts?(wt)` on `PlanningPhaseHooks`. OpenSpec implements it. Freeform omits it. When present and successful, `runPlanningPhases` sets `promptPlanText` and `specContext` from the result before `buildPlanReviewPrompt`. When absent, comment text stays the plan (freeform).

The OpenSpec implementation SHALL use one resolved-change flow:

1. If `changeId` is empty, call `restoreChangeIdIfEmpty`.
2. If restore fails, return `{ ok: false, tag: "openspec-invalid", reason }` from that helper.
3. If `changeId` is already non-empty, skip restore. Do not pick a different id.
4. Read `proposal.md` with injected `readChangeFile` (same reader as `authorArtifact`).
5. If that read is null or blank after trim, fail per D3. Do not substitute the GitHub comment.
6. Read spec deltas with injected `readSpecDeltas`. Empty concatenation is `""`. A thrown reader fails per D3.
7. Return `{ ok: true, promptPlanText, specContext }`.

Keep `planComment` as the GitHub comment for human-feedback extraction. After a successful bind, the runner MUST NOT assign `promptPlanText` from that comment.

Do not scrape `_OpenSpec change \`id\`` from the comment. Do not persist `changeId` in run-state JSON.

Alternative considered: restore and read inside `runPlanningPhases` at `resumePlanReview`. Rejected: the runner would learn OpenSpec identity, which #1416 already rejected.

Alternative considered: call `revalidateArtifact(wt, comment)` on resume to reuse its return shape. Rejected: that also runs `validateItem` before review and changes resume failure timing. Artifact binding is not a new validation gate.

Alternative considered: a new required hook. Rejected: unrequested interface. Optional methods already exist for OpenSpec-only resume/review differences.

### D2 — Non-singular OpenSpec resume blocks; freeform falls back to the comment

When `bindResumePlanArtifacts` fails restore, return the same `{ ok: false, tag: "openspec-invalid" }` named restore reason #1416 already uses. The runner `setBlocked`s at plan-review before `invokeReviewer` or `invokeRevision`. Do not review the stale comment as if it were a living OpenSpec proposal.

Freeform has no bind method, so it keeps the comment. That is the allowed fallback.

Do not add a BlockerKind or `BLOCKER_RECIPES` entry.

### D3 — Missing or blank `proposal.md` after a resolved id is a bind failure

Resume binds a change that already exists. If `readChangeFile(..., "proposal.md")` returns null or blank after trim, return `{ ok: false, tag: "openspec-invalid" }` with a reason that names the change id and the unreadable `proposal.md`. Do not invoke the reviewer or reviser. Do not substitute the GitHub comment. Do not pass `"(proposal.md not found)"` as plan text. That placeholder is first-pass authoring only.

Empty spec-delta concatenation stays `""`, same as first-pass authoring. Empty deltas are not a read failure. If the injected `readSpecDeltas` throws, treat that throw as the same bind failure (tag `openspec-invalid`).

Do not invent a new BlockerKind. Do not re-run singularity to pick a different id after a resolved id fails to read.

### D4 — Extend the existing hook inject bag for file reads

Add `readChangeFile` and `readSpecDeltas` to `OpenspecPlanningHookInjects`, defaulting to `openspec.readChangeFile` / `openspec.readSpecDeltas`. Tests pass fakes. Production stays on the module functions.

Do not add live filesystem to unit tests. Do not merge this bag with `RunPlanningPhasesDeps.listChangeDirs` in this change.

### D5 — Class coverage, not implementing-resume wiring

The reusable bind (restore + file readers, optional hook) is the class fix for skipped-author OpenSpec plan text. Implementing-resume that still copies the comment is a sibling site. Empty-name restore (#1416) plus this bind are the shared pieces that later caller can use without a new mole for "stale comment vs living proposal".

### D6 — No prompt-template or review-schema edits

`buildPlanReviewPrompt` / `buildPlanRevisionPrompt` already accept `plan` and `specContext`. Fill those fields. Do not add a "posted comment (history)" section. `planReviewCwd` already points at the worktree, so `design.md` / `tasks.md` remain living files the reviewer can read.

### D7 — `design.md` and `tasks.md` stay on disk

The issue names `proposal.md`, spec deltas, and design/tasks as living artifacts. First-pass authoring inlines only `proposal.md` (`promptPlanText`) and `readSpecDeltas` (`specContext`). `readSpecDeltas` walks `openspec/changes/<id>/specs/**/*.md` only.

Resume matches that contract. Do not add prompt placeholders for `design.md` or `tasks.md`. Do not concatenate those files into `specContext`. Keep `planReviewCwd = wt.path` so the reviewer can inspect them in the change directory.

### D8 — Runner order: comment for eligibility and history, bind for plan text

The `resumePlanReview` branch still requires a completed `## Implementation Plan` comment (#870). That comment stays `planComment` for `extractHumanPlanComments`. If OpenSpec `bindResumePlanArtifacts` is present, call it next. On success, set `promptPlanText` and `specContext` from the bind. On failure, `setBlocked` at plan-review with the hook tag and reason, then return. Do not call `authorArtifact`. Do not build review or revision prompts from the comment when the bind hook is present.

## Risks / Trade-offs

- **[Risk]** Operator-committed worktree pins can differ from the posted comment. Reviewers may still ask for comment-only wording.
  → Mitigation: the prompt plan text is the worktree proposal. That is the required source of truth. Do not also paste the stale comment as plan text. Tests assert the captured review/revision prompts contain the worktree pins and are not comment-only.

- **[Risk]** `beforeList` comes from `cfg.repo_dir`. Shared multi-change trees still fail singularity, as in #1416.
  → Mitigation: keep the singularity contract. Block rather than pick an arbitrary id.

- **[Risk]** A non-empty stale `changeId` could point at a deleted directory while another change exists.
  → Mitigation: do not re-pick. Missing `proposal.md` blocks with `openspec-invalid`. That is fail-closed identity, not comment fallback.

- **[Risk]** Optional-hook duck-typing can drift if a test hand-builds OpenSpec-shaped hooks without the bind.
  → Mitigation: the concrete `makeOpenspecPlanningHooks` regression is the bite. Hand-built hooks without the method keep comment behavior, which is the freeform fallback.

- **[Risk]** Inject-at-construction can drift from `RunPlanningPhasesDeps`.
  → Mitigation: accepted for this cut, same as #1416. Unifying the seams is extra scope.

## Migration Plan

No schema, label, or CLI migration. Ship in the engine. Existing OpenSpec plan-review resume starts binding worktree files on the next run.

Rollback: revert the optional bind and the resume-branch call. No durable state to unwind.

## Open Questions

None. Implementing-resume reuse is deferred by design (D5), not an open product question. Inlining `design.md` / `tasks.md` is declined by design (D7).
