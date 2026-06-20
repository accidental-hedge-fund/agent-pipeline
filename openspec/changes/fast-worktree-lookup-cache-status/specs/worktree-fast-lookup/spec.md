## ADDED Requirements

### Requirement: `getOnDiskForIssue` resolves a worktree path without GitHub calls
`getOnDiskForIssue(cfg, issueNumber)` SHALL return the path and slug of the on-disk worktree for the given issue number by reading only the local git worktree list — it SHALL NOT call any GitHub API. If no on-disk worktree exists for that issue it SHALL return `null`.

#### Scenario: found on disk
- **WHEN** a worktree directory for issue 42 exists on disk
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return `{ path, slug }` without issuing any `gh` subprocess call

#### Scenario: not on disk
- **WHEN** no worktree directory for issue 42 exists on disk
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return `null` without issuing any `gh` subprocess call

#### Scenario: multiple worktrees, correct one returned
- **WHEN** on-disk worktrees exist for issues 10, 42, and 99
- **THEN** `getOnDiskForIssue(cfg, 42)` SHALL return the record for issue 42 only

### Requirement: Pipeline run setup and bookkeeping SHALL use `getOnDiskForIssue`
The four call sites in the pipeline dispatch loop that resolve the worktree path for a known issue (run setup, per-stage bookmark, post-fix verification, and run finalization) SHALL use `getOnDiskForIssue` instead of `getForIssue`. They SHALL NOT call `listActive` as a side-effect of resolving the path.

#### Scenario: run setup does not trigger active-state GitHub calls
- **WHEN** a pipeline run begins for issue N with 20 other worktrees on disk
- **THEN** resolving the worktree path for issue N SHALL NOT issue `gh` calls for those 20 other worktrees

#### Scenario: active-state filtering is still used for capacity enforcement
- **WHEN** `createWorktree` checks whether the concurrency cap is reached
- **THEN** it SHALL still call `listActive` (which calls GitHub per worktree) to determine the active count

### Requirement: `RunStateCache` batches GitHub reads at named refresh points
A `RunStateCache` instance SHALL be created once per pipeline dispatch cycle. It SHALL expose:
- `refreshAfterSetup(cfg)` — fetches issue state/labels and PR state; called once after initial worktree setup.
- `refreshAfterFix(cfg)` — re-fetches the same data after a fix commit lands.
- Typed read-only accessors for cached issue state, labels, PR state, and worktree path.

Accessors SHALL throw a clear error if called before the first successful `refresh*` call so stale-read bugs surface immediately.

#### Scenario: accessors throw before first refresh
- **WHEN** a `RunStateCache` is created but no `refresh*` method has been called
- **THEN** accessing any cached value SHALL throw with a message indicating the cache has not been populated

#### Scenario: accessors return fresh data after refresh
- **WHEN** `refreshAfterSetup` is called and the GitHub fetch succeeds
- **THEN** accessors SHALL return the values retrieved during that refresh without issuing additional GitHub calls

#### Scenario: second refresh updates cached values
- **WHEN** `refreshAfterFix` is called after `refreshAfterSetup`
- **THEN** accessors SHALL return the values from the most recent refresh

#### Scenario: cache is injected via deps for unit testing
- **WHEN** a stage function is unit-tested with a fake `RunStateCache` injected through the `deps` parameter
- **THEN** the stage SHALL read from the injected cache without issuing any real GitHub calls
