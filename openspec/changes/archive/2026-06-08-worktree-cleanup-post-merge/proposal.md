## Why

Worktrees created by the pipeline persist on disk after their associated PRs are merged — when a PR is merged manually, when a pipeline run blocks before finalize, or when the `deploy_ready` stage doesn't complete cleanup. There is no sweep that removes these stale checkouts, so they accumulate over time and clutter the worktree directory.

## What Changes

- `core/scripts/worktree.ts` gains a `sweepMergedWorktrees(cfg)` function that:
  - Lists all on-disk pipeline-managed worktrees (existing `listOnDisk`).
  - For each, checks whether its associated PR has been merged via the GitHub API.
  - Skips worktrees with uncommitted local changes and reports them as "skipped".
  - Removes the worktree (disk + git registration) and its local branch for merged-PR worktrees.
  - Returns a structured report: `{ removed: WorktreeRecord[], skipped: Array<{rec: WorktreeRecord, reason: string}> }`.
- A new `cleanup` pipeline entry point (invoked via `--cleanup` flag or `cleanup` mode string) calls `sweepMergedWorktrees` and prints the report.
- Cleanup is additive and safe: it only removes worktrees under `cfg.worktree_root` whose branch matches the `pipeline/<N>-<slug>` naming convention. No unrelated or user-created worktrees are ever touched.
- The existing per-issue removal in `deploy_ready` and `auto_recover` stages is unchanged.

## Capabilities

### New Capabilities

- `worktree-stale-cleanup`: Sweep pipeline-managed worktrees whose PR has been merged, skip worktrees with local changes, report removed and skipped items. Triggered via an explicit `--cleanup` / `cleanup` mode; idempotent and non-destructive by default.

### Modified Capabilities

_(none — no existing spec-level behavior changes)_

## Impact

- **`core/scripts/worktree.ts`**: new `sweepMergedWorktrees` function (~60–90 lines), one new helper `hasDirtyWorkdir` using `git status --porcelain`.
- **`core/scripts/gh.ts`** (or inline): new `getPrMergeStatus(cfg, issueNumber)` helper that calls `gh pr list --search "is:merged" --json mergedAt` or `gh pr view` to determine whether a PR for the given branch is merged.
- **`core/pipeline.ts`** (or equivalent entry point): route the `cleanup` mode to `sweepMergedWorktrees` and print the report.
- **`core/test/worktree.test.ts`**: unit tests for sweep logic.
- **No breaking changes** — existing stage behavior is untouched; cleanup is opt-in.
