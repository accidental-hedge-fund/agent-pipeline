## 1. Inject bag and optional bind hook

- [x] 1.1 Extend `OpenspecPlanningHookInjects` with `readChangeFile` and `readSpecDeltas`, defaulting to the `openspec` module functions, and verify a unit test can replace both while production still uses the module readers
- [x] 1.2 Add optional `bindResumePlanArtifacts?(wt)` on `PlanningPhaseHooks` returning `{ ok: true, promptPlanText, specContext }` or `{ ok: false, reason, tag }`, and verify TypeScript callers and freeform hooks still compile without implementing it

## 2. Bind living artifacts on OpenSpec resume

- [x] 2.1 Add a hook-level test that constructs `makeOpenspecPlanningHooks`, skips `authorArtifact`, injects one fresh change plus a `proposal.md` that contains pins absent from a stale comment string, calls `bindResumePlanArtifacts`, and verify it fails today because the method is missing or still unused
- [x] 2.2 Implement OpenSpec `bindResumePlanArtifacts` as one resolved-change flow: `restoreChangeIdIfEmpty` when `changeId` is empty, then injected `readChangeFile(..., "proposal.md")` and `readSpecDeltas` from that resolved id. Missing or blank `proposal.md` returns `{ ok: false, tag: "openspec-invalid" }`. Empty deltas are `""`. A thrown spec-delta reader is the same bind failure. Verify the 2.1 test now returns the injected proposal and deltas
- [x] 2.3 Add hook-level cases for exactly-one active-change fallback, zero active changes, and multiple fresh changes, and verify bind uses the single active id, returns the named change-id restore failure (tag `openspec-invalid`) for zero and multi-fresh, and never scrapes the GitHub comment to choose the id
- [x] 2.4 Add a hook-level empty-id path: `changeId` starts empty, restore chooses one fresh id, bind reads that id's files, and verify the returned plan text is that `proposal.md`
- [x] 2.5 Add a hook-level non-empty-id path: after `changeId` is already set, change the injected listing to a different set, call bind again, and verify it still reads the original id and does not re-pick
- [x] 2.6 Add a hook-level unreadable-proposal path for a resolved id (`readChangeFile` returns null or blank), and verify bind returns tag `openspec-invalid`, names the change id, and does not return comment text as `promptPlanText`

## 3. Shared runner resume path

- [x] 3.1 Drive `runPlanningPhases` with `resumePlanReview: true`, concrete OpenSpec hooks, one restorable change, a stale GitHub plan comment, and injected worktree `proposal.md` / spec deltas that contain prior `NEEDS_REVISION` pins, capture the plan-review prompt, and verify the test fails if that prompt's plan text is only the comment
- [x] 3.2 In the `resumePlanReview` branch, keep `planComment` from `extractPlan`, call `hooks.bindResumePlanArtifacts` when present, set `promptPlanText` / `specContext` from a successful bind, and `setBlocked` on bind failure with the hook reason and tag. Do not assign `promptPlanText` from the comment after a successful bind. Then verify the 3.1 test passes with worktree proposal and spec deltas in the plan-review prompt
- [x] 3.3 Extend the 3.1 driver so plan-review returns `NEEDS_REVISION` and capture the plan-revision prompt (`revisePlan` / `invokeRevision` or `invoke` prompt argument), and verify it also contains the bound worktree proposal and spec deltas rather than only the stale comment
- [x] 3.4 Confirm plan-review resume still skips `authorArtifact` in that same test, and verify the authoring harness invoke count stays zero
- [x] 3.5 Drive freeform plan-review resume with a completed plan comment and no bind method, and verify the plan-review prompt still uses the GitHub comment and does not require an OpenSpec change directory
- [x] 3.6 Drive OpenSpec resume with zero restore candidates and with multiple fresh candidates, and verify `setBlocked` uses tag `openspec-invalid` and a named change-id restore reason, and `invokeReviewer` / `invokeRevision` are not called
- [x] 3.7 Drive OpenSpec resume with a resolved id whose injected `proposal.md` is missing, and verify the stage blocks with tag `openspec-invalid` before `invokeReviewer` / `invokeRevision` and does not pass the GitHub comment as plan text

## 4. Scope freeze and CI

- [x] 4.1 Confirm the diff does not change train, merge-authority, review-schema, or park-release behavior, and verify `git diff` has no edits under those modules except incidental shared-type churn
- [x] 4.2 Confirm the diff does not add prompt placeholders for `design.md` or `tasks.md`, and verify OpenSpec `planReviewCwd` still returns `wt.path`
- [x] 4.3 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [x] 4.4 Run `openspec validate plan-review-resume-worktree-openspec` and `openspec validate --all`, and verify both exit 0
- [x] 4.5 Run `npm run ci` from the repo root, and verify the full gate passes
