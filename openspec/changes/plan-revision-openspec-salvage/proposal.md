## Why

OpenSpec authoring salvages uncommitted `openspec/` work when the harness does not commit (`salvageIfNoNewCommit` after `authorArtifact`). Plan revision does not. On #1301, the plan-revision harness revised OpenSpec files after `NEEDS_REVISION` and left them uncommitted. Combined with empty-`changeId` validation failure, park-release then removed a clean worktree at remote tip (`park-release: released managed worktree for #1301 (clean + remote tip …)`). The revision never landed. Even after changeId restore, an uncommitted revision can still be dropped if the stage blocks or park-releases before implementing salvage runs.

## What Changes

- After a successful plan-revision harness invocation (initial invoke and the shared format-repair retry), the engine SHALL salvage uncommitted `openspec/` work with the existing `salvageIfNoNewCommit` helper and the same `openspec/` staging scope as OpenSpec authoring.
- Salvage SHALL run before `revalidateArtifact`, before any plan-review block, and therefore before park-release can treat the worktree as a clean remote-tip candidate.
- When salvage is attempted and its git operation fails, the subsequent blocker SHALL name that failure reason (parity with authoring / #521 disclosure). A clean in-scope worktree remains a no-op.
- A biting regression SHALL fail if plan revision leaves `openspec/` dirty and the stage returns blocked/parked without salvage.
- No new salvage engine, no `runHarnessRound` migration for plan-revision, no implement-stage path widening, no park-release law change, no merge-authority or review-policy change.

This is a class fix at the shared plan-revision call site, not a #1301-only mole. Authoring already holds the first reuse rung. Revision is the missing sibling of the same OpenSpec-writing planning class.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `harness-uncommitted-salvage`: after a successful plan-revision harness invocation, salvage uncommitted `openspec/` work with the existing scoped helper before revalidate/block/park-release; disclose salvage failure on the blocker; keep implement/fix/test-fix salvage unscoped.

## Impact

- Code: `core/scripts/stages/planning.ts` (`runPlanningPhases` plan-revision path). Reuse `salvageIfNoNewCommit` and the existing `deps.gitInWorktree` / `deps.trySalvageUncommittedWork` seams. No new module.
- Tests: `core/test/planning.test.ts` (and salvage tests only if a call-site assertion belongs there). Inject git/salvage seams. No live network, git, or subprocess in unit tests.
- After `core/` edits: `node scripts/build.mjs` and `npm run ci`.
- Park-release of a truly clean remote-tip worktree is unchanged. Force-push of unpublished local-only commits during train reclaim (#622) is unchanged.

## Acceptance Criteria

- [ ] After a successful plan-revision harness invocation with no new commit and dirty `openspec/` files, the engine creates a salvage commit scoped to `openspec/` (or reports the salvage failure on the blocker) before `revalidateArtifact`, `setBlocked`, or park-release.
- [ ] The same salvage runs after a successful plan-revision format-repair retry that leaves uncommitted `openspec/` work.
- [ ] Salvage stages only `openspec/` paths. A dirty file outside `openspec/` (for example `tasks/todo.md` or `core/scripts/foo.ts`) is not committed by this salvage.
- [ ] When salvage git fails, the plan-review blocker text includes the salvage failure reason. The stage does not return blocked/parked as if no revision existed.
- [ ] When `openspec/` is clean after revision (nothing in-scope to salvage), existing revalidate/block behavior is unchanged and no salvage commit is created.
- [ ] A unit regression fails if the plan-revision path returns blocked/parked while `openspec/` is dirty and salvage was not attempted. Tests inject git/salvage seams and do not spawn real git, network, or harness processes.
- [ ] Implement, fix-round, and test-fix salvage call sites stay unscoped. Park-release of a truly clean remote-tip worktree is unchanged. No merge-authority or review-policy change.
- [ ] `node scripts/build.mjs` and `npm run ci` pass after `core/` edits.
