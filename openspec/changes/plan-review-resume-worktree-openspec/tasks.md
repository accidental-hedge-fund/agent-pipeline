## 1. Inject bag and optional bind hook

- [ ] 1.1 Extend `OpenspecPlanningHookInjects` with `readChangeFile` and `readSpecDeltas`, defaulting to the `openspec` module functions, and verify a unit test can replace both while production still uses the module readers
- [ ] 1.2 Add optional `bindResumePlanArtifacts?(wt)` on `PlanningPhaseHooks` returning `{ ok: true, promptPlanText, specContext }` or `{ ok: false, reason, tag }`, and verify TypeScript callers and freeform hooks still compile without implementing it

## 2. Bind living artifacts on OpenSpec resume

- [ ] 2.1 Add a hook-level test that constructs `makeOpenspecPlanningHooks`, skips `authorArtifact`, injects one fresh change plus a `proposal.md` that contains pins absent from a stale comment string, calls `bindResumePlanArtifacts`, and verify it fails today because the method is missing or still unused
- [ ] 2.2 Implement OpenSpec `bindResumePlanArtifacts` with `restoreChangeIdIfEmpty` then injected `readChangeFile(..., "proposal.md")` and `readSpecDeltas`, matching first-pass authoring (missing proposal uses `"(proposal.md not found)"`; empty deltas are `""`), and verify the 2.1 test now returns the injected proposal and deltas
- [ ] 2.3 Add hook-level cases for exactly-one active-change fallback, zero active changes, and multiple fresh changes, and verify bind uses the single active id, returns the named change-id restore failure (tag `openspec-invalid`) for zero and multi-fresh, and never scrapes the GitHub comment to choose the id

## 3. Shared runner resume path

- [ ] 3.1 Drive `runPlanningPhases` with `resumePlanReview: true`, concrete OpenSpec hooks, one restorable change, a stale GitHub plan comment, and injected worktree `proposal.md` / spec deltas that contain prior `NEEDS_REVISION` pins, capture the plan-review prompt, and verify the test fails if that prompt's plan text is only the comment
- [ ] 3.2 In the `resumePlanReview` branch, call `hooks.bindResumePlanArtifacts` when present, set `promptPlanText` / `specContext` from a successful bind, keep `planComment` as the GitHub comment, and `setBlocked` on bind failure with the hook reason and tag, then verify the 3.1 test passes with worktree proposal and spec deltas in the plan-review prompt
- [ ] 3.3 Extend the 3.1 driver so plan-review returns `NEEDS_REVISION` and capture the plan-revision prompt, and verify it also contains the bound worktree proposal and spec deltas rather than only the stale comment
- [ ] 3.4 Confirm plan-review resume still skips `authorArtifact` in that same test, and verify the authoring harness invoke count stays zero
- [ ] 3.5 Drive freeform plan-review resume with a completed plan comment and no bind method, and verify the plan-review prompt still uses the GitHub comment and does not require an OpenSpec change directory

## 4. Scope freeze and CI

- [ ] 4.1 Confirm the diff does not change train, merge-authority, review-schema, or park-release behavior, and verify `git diff` has no edits under those modules except incidental shared-type churn
- [ ] 4.2 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` passes
- [ ] 4.3 Run `openspec validate plan-review-resume-worktree-openspec` and `openspec validate --all`, and verify both exit 0
- [ ] 4.4 Run `npm run ci` from the repo root, and verify the full gate passes
