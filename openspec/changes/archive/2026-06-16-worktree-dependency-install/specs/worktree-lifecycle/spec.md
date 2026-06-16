## MODIFIED Requirements

### Requirement: Worktree created off the latest base; stale path reclaimed
`createWorktree` SHALL fetch and branch off the latest `origin/<base_branch>`. If a directory already exists at the target path it SHALL be removed first. After the git worktree is created, the dependency install step (as specified in `worktree-dependency-install`) SHALL be executed before control returns to the caller, so that every worktree is fully bootstrapped and runnable from the moment it is created.

#### Scenario: stale path
- **WHEN** a directory already exists at the target worktree path
- **THEN** it SHALL be removed before the new worktree is created off `origin/<base_branch>`

#### Scenario: worktree is dependency-installed before first use
- **WHEN** a worktree is freshly created for an issue
- **THEN** the dependency install step SHALL run inside that worktree before `createWorktree` returns
- **AND** all subsequent stages SHALL be able to invoke binaries that the install step provides
