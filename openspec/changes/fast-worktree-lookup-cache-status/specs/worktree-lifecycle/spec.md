## MODIFIED Requirements

### Requirement: Concurrency gated on active worktrees only
`createWorktree` SHALL refuse (throw) when the count of *active* worktrees is at `cfg.max_concurrent_worktrees`. A worktree counts as active only when its issue is open on GitHub AND does not carry `pipeline:ready-to-deploy`; closed issues and terminal (ready-to-deploy) ones are excluded. On a `gh` lookup failure a worktree is treated as active (fail-safe). All other callers that need only the path of a known-issue worktree SHALL use `getOnDiskForIssue` rather than routing through `listActive`.

#### Scenario: terminal worktrees don't count
- **WHEN** several on-disk worktrees belong to issues labeled `pipeline:ready-to-deploy`
- **THEN** they SHALL be excluded from the active count used to gate creation

#### Scenario: at capacity
- **WHEN** the active worktree count equals `cfg.max_concurrent_worktrees` and a new worktree is requested
- **THEN** `createWorktree` SHALL throw a capacity error rather than create another

#### Scenario: non-capacity callers do not trigger active-state lookups
- **WHEN** the pipeline resolves the worktree path for a known issue outside of `createWorktree` or `sweepMergedWorktrees`
- **THEN** no `gh` call SHALL be issued to determine whether that or any other worktree is active
