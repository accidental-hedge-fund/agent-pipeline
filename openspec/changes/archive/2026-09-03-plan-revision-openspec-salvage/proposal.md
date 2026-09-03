## Why

OpenSpec authoring salvages uncommitted `openspec/` work when the harness does not commit (`salvageIfNoNewCommit` after `authorArtifact`). Plan revision does not. On #1301, the plan-revision harness revised OpenSpec files after `NEEDS_REVISION` and left them uncommitted. Combined with empty-`changeId` validation failure, park-release then removed a clean worktree at remote tip (`park-release: released managed worktree for #1301 (clean + remote tip …)`). The revision never landed. Even after changeId restore, an uncommitted revision can still be dropped if the stage blocks or park-releases before implementing salvage runs.

## What Changes

- After every successful plan-revision harness process exit (initial invoke and the shared format-repair retry), the engine SHALL salvage uncommitted `openspec/` work with the existing `salvageIfNoNewCommit` helper and the same `openspec/` staging scope as OpenSpec authoring.
- Each invoke SHALL capture its own comparison HEAD immediately before that process starts. Salvage for that invoke SHALL compare against that HEAD, not against a HEAD captured only before the first invoke.
- Salvage SHALL run immediately after that successful process exit, before acknowledgement validation, before `revalidateArtifact`, before any plan-review block, and therefore before park-release can treat the worktree as a clean remote-tip candidate.
- When salvage is attempted and its git operation fails, the captured `failureReason` SHALL survive every later plan-review path (ack exhaustion, claims, revalidate, human-feedback ack, and a later successful revalidate). The subsequent blocker SHALL name that reason. A failed salvage SHALL NOT allow advance or park-release with dirty OpenSpec work even when revalidate otherwise succeeds. A clean in-scope worktree remains a no-op.
- A biting regression SHALL fail if plan revision leaves `openspec/` dirty and the stage returns blocked/parked without salvage. Tests SHALL use an event log to prove salvage runs before revalidate/block.
- No new salvage engine, no `runHarnessRound` migration for plan-revision, no implement-stage path widening, no park-release law change, no merge-authority or review-policy change.

This is a class fix at the shared plan-revision call site, not a #1301-only mole. Authoring already holds the first reuse rung. Revision is the missing sibling of the same OpenSpec-writing planning class. Revision SHALL recapture HEAD per invoke; it SHALL NOT copy authoring’s single-HEAD reuse across format-repair, because that reuse skips retry salvage after the first salvage advances HEAD.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `harness-uncommitted-salvage`: after every successful plan-revision harness invocation, salvage uncommitted `openspec/` work with the existing scoped helper before revalidate/block/park-release; compare each invoke against its own pre-invoke HEAD; disclose salvage failure on every later plan-review blocker and as a terminal plan-review block when revalidate otherwise succeeds; keep implement/fix/test-fix salvage unscoped.

## Impact

- Code: `core/scripts/stages/planning.ts` (`runPlanningPhases` plan-revision path). Reuse `salvageIfNoNewCommit` and the existing `deps.gitInWorktree` / `deps.trySalvageUncommittedWork` seams. No new module.
- Tests: `core/test/planning.test.ts` (and salvage helper tests only if a call-site assertion belongs there). Inject git/salvage seams. Event log for ordering. No live network, git, or subprocess in unit tests.
- After `core/` edits: `node scripts/build.mjs` and `npm run ci`.
- Park-release of a truly clean remote-tip worktree is unchanged. Force-push of unpublished local-only commits during train reclaim (#622) is unchanged.

## Acceptance Criteria

- [ ] After a successful plan-revision harness invocation with no new commit and dirty `openspec/` files, the engine creates a salvage commit scoped to `openspec/` (or reports the salvage failure on the blocker) before `revalidateArtifact`, `setBlocked`, or park-release.
- [ ] Salvage runs immediately after the initial successful invoke even when the acknowledgement contract later triggers format repair.
- [ ] The same salvage runs after a successful plan-revision format-repair retry that leaves uncommitted `openspec/` work, comparing against the HEAD captured immediately before that retry invoke.
- [ ] After an initial salvage commit advances HEAD, a successful retry that leaves new dirty `openspec/` work still attempts salvage (retry comparison HEAD is not the pre-initial HEAD).
- [ ] Salvage stages only `openspec/` paths. A dirty file outside `openspec/` (for example `tasks/todo.md` or `core/scripts/foo.ts`) is not committed by this salvage.
- [ ] When salvage git fails, every later plan-review blocker includes the captured salvage failure reason. The stage does not return blocked/parked as if no revision existed.
- [ ] When salvage git fails and revalidate otherwise succeeds, plan-review still blocks, discloses the salvage failure, and does not advance or park-release with dirty OpenSpec work.
- [ ] When `openspec/` is clean after revision (nothing in-scope to salvage), existing revalidate/block behavior is unchanged and no salvage commit is created.
- [ ] A unit regression fails if the plan-revision path returns blocked/parked while `openspec/` is dirty and salvage was not attempted. Tests inject git/salvage seams, use an event log to prove salvage-before-revalidate/block, and do not spawn real git, network, or harness processes.
- [ ] Implement, fix-round, and test-fix salvage call sites stay unscoped. Park-release of a truly clean remote-tip worktree is unchanged. No merge-authority or review-policy change.
- [ ] `node scripts/build.mjs` and `npm run ci` pass after `core/` edits. No test-pass claim is made until that gate is green.
