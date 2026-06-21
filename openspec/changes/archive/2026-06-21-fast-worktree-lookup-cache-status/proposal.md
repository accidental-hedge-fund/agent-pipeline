## Why

`getForIssue()` calls `listActive()`, which issues one GitHub lookup per on-disk worktree to decide whether each worktree is still active. Many pipeline callers already know the issue number and need only the local worktree path. Those callers should not trigger active-state fan-out.

## What Changes

- Add `getOnDiskForIssue()`, a disk-only worktree resolver for known issue numbers.
- Use `getOnDiskForIssue()` for pipeline setup/bookkeeping, `--status --json`, and stage path lookups that do not need active-state filtering.
- Keep `listActive()` / `countActive()` for capacity enforcement and any caller that genuinely needs active-state filtering.
- Defer per-run issue/PR snapshot caching to a separate, narrower design.

## Capabilities

### New Capabilities

- `worktree-fast-lookup`: Resolve a known issue's local worktree path from on-disk records without GitHub calls.

### Modified Capabilities

- `worktree-lifecycle`: The concurrency gate continues to use active-state filtering; path-only known-issue callers use `getOnDiskForIssue()` instead of `getForIssue()`.

## Impact

- `core/scripts/worktree.ts`: add `getOnDiskForIssue()`.
- `core/scripts/pipeline.ts`: use the fast path for status JSON and run bookkeeping worktree path lookups.
- `core/scripts/stages/**`: default path-only worktree lookups to the fast path while preserving test seams.
- `core/test/worktree-fast-lookup.test.ts`: cover the disk-only resolver and stage default usage.
- No CLI-visible behavior change; GitHub call count for known-issue path resolution no longer grows with unrelated worktree count.

## Acceptance Criteria

- [ ] `getOnDiskForIssue(cfg, N)` returns the worktree path/slug for issue N by reading on-disk records only.
- [ ] Status JSON and pipeline bookkeeping path lookups use `getOnDiskForIssue()` rather than `getForIssue()`.
- [ ] Stage path-only worktree lookups default to `getOnDiskForIssue()` while injectable test seams remain available.
- [ ] Capacity enforcement still uses active-state filtering.
- [ ] Tests cover the disk-only resolver and source-level stage default usage.
- [ ] Full CI passes with the generated plugin mirror in sync.
