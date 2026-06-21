# worktree-fast-lookup Specification

## Purpose
TBD - created by archiving change fast-worktree-lookup-cache-status. Update Purpose after archive.
## Requirements
### Requirement: `getOnDiskForIssue` resolves a worktree path without GitHub calls
`getOnDiskForIssue(cfg, issueNumber)` SHALL return the path and slug of the on-disk worktree for the given issue number by reading only the local git worktree list. It SHALL NOT call any GitHub API. If no on-disk worktree exists for that issue it SHALL return `null`.

#### Scenario: found on disk
- **WHEN** a worktree directory for issue 42 exists on disk
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return `{ path, slug }` without issuing any GitHub subprocess call

#### Scenario: not on disk
- **WHEN** no worktree directory for issue 42 exists on disk
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return `null` without issuing any GitHub subprocess call

#### Scenario: multiple worktrees, correct one returned
- **WHEN** on-disk worktrees exist for issues 10, 42, and 99
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return the record for issue 42 only

### Requirement: Known-issue path-only lookups SHALL use `getOnDiskForIssue`
Pipeline setup, status JSON, run bookkeeping, and stage handlers that resolve a worktree path for a known issue SHALL use `getOnDiskForIssue` directly or default their injectable path lookup seam to `getOnDiskForIssue`. They SHALL NOT call `listActive` as a side-effect of path-only lookup.

#### Scenario: status JSON does not trigger active-state fan-out
- **WHEN** status JSON is generated for issue N with unrelated worktrees on disk
- **THEN** resolving issue N's worktree path SHALL NOT issue GitHub calls for unrelated worktrees

#### Scenario: stage path lookup does not trigger active-state fan-out
- **WHEN** a stage needs only the worktree path for the issue it is already processing
- **THEN** its default lookup SHALL use `getOnDiskForIssue`

#### Scenario: active-state filtering is still used for capacity enforcement
- **WHEN** `createWorktree` checks whether the concurrency cap is reached
- **THEN** it SHALL still use active-state filtering to determine the active count

