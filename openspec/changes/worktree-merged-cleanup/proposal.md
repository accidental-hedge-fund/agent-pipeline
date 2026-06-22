## Why

The pipeline has two worktree-removal paths today — bulk `--cleanup` (merged-only, bulk, silently skips dirty) and `deploy_ready` (fires before the human merges) — but no targeted per-issue removal that Pipeline Desk can call when an operator clicks "Remove worktree" for a specific run. Pipeline Desk issue #164 needs exactly that contract: remove one issue's worktree regardless of merge state, and surface dirty state rather than silently skipping it so the UI can warn-and-confirm.

## What Changes

- Add `--remove-worktree` flag to `pipeline N` (alongside existing bypass-path flags `--status`, `--unblock`, `--override`). When supplied, the pipeline targets issue N's on-disk worktree, checks for uncommitted changes, removes the worktree directory + local branch (never the remote), and exits.
- Add `--force` modifier: without it, a dirty worktree blocks removal and exits non-zero; with it, the worktree is removed despite uncommitted changes with a warning.
- Add `--json` output for the remove-worktree mode: machine-readable result with `worktree`, `branch`, `removed`, `dirty`, and `error` fields so Pipeline Desk can parse the outcome programmatically.
- Implement the per-issue removal logic in `worktree.ts` as an injectable-deps function (`removeWorktreeForIssue` / `RemoveWorktreeDeps`) so it is unit-testable without real git or filesystem.
- `--remove-worktree` bypasses the kill switch (maintenance action, same policy as `--unblock` and `--override`).

## Capabilities

### New Capabilities
- `worktree-per-run-removal`: The `pipeline N --remove-worktree` flag: per-issue worktree removal regardless of merge state, with dirty-state surfacing, `--force`, and `--json` output.

### Modified Capabilities
_(none — existing `worktree-stale-cleanup` requirements are unchanged)_

## Impact

- `core/scripts/pipeline.ts` — commander flag definitions (`--remove-worktree`, `--force` scoped to this mode), dispatch block, `runRemoveWorktree` handler.
- `core/scripts/worktree.ts` — new `removeWorktreeForIssue` function and `RemoveWorktreeDeps` interface.
- `core/test/worktree-remove.test.ts` — unit tests for the new handler (injectable deps, no real git or network).
- `plugin/` mirror — regenerated after any `core/` change.
- `README.md` — document `--remove-worktree`.

## Acceptance Criteria

- [ ] `pipeline N --remove-worktree` targets only issue N's worktree; does not sweep other worktrees.
- [ ] The command works regardless of whether the PR for issue N is open, merged, or does not exist.
- [ ] A clean worktree is removed (directory gone, local branch deleted, remote branch untouched) and the process exits zero.
- [ ] A dirty worktree without `--force` exits non-zero and reports the uncommitted-changes reason; the worktree is NOT removed.
- [ ] A dirty worktree with `--force` is removed despite uncommitted changes; the process exits zero with a warning logged.
- [ ] When no worktree is found for issue N, the process exits non-zero with a clear not-found message.
- [ ] `--json` emits a single JSON object with at least: `removed` (boolean), `dirty` (boolean), `branch` (string|null), `worktree` (string|null), and `error` (string|null when applicable).
- [ ] `--remove-worktree` bypasses the kill switch (same as `--unblock`, `--override`).
- [ ] All logic is covered by unit tests using injectable deps (no real git, network, or filesystem in tests).
- [ ] `npm run ci` passes end-to-end after the change.
