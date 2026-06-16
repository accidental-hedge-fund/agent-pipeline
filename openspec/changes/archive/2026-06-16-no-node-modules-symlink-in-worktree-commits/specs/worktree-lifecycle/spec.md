## MODIFIED Requirements

### Requirement: Worktree created off the latest base; stale path reclaimed
`createWorktree` SHALL fetch and branch off the latest `origin/<base_branch>`. If a directory already exists at the target path it SHALL be removed first. After the git worktree is created, the pipeline SHALL: (1) write the `node_modules` staging exclusion to `.git/info/exclude` inside the worktree, (2) remove any pre-existing `node_modules` symlink at the worktree root and log the removal, and (3) execute the dependency install step (as specified in `worktree-dependency-install`) before control returns to the caller, so that every worktree is fully bootstrapped and runnable from the moment it is created.

#### Scenario: stale path
- **WHEN** a directory already exists at the target worktree path
- **THEN** it SHALL be removed before the new worktree is created off `origin/<base_branch>`

#### Scenario: node_modules local exclude written during bootstrap
- **WHEN** a worktree is freshly created for an issue
- **THEN** the pipeline SHALL write the pattern `node_modules` to `.git/info/exclude` inside the worktree before any stage or harness runs
- **AND** subsequent `git add` commands in that worktree SHALL not stage any `node_modules` entry

#### Scenario: pre-existing node_modules symlink removed during bootstrap
- **WHEN** a `node_modules` symlink exists at the worktree root at bootstrap time (e.g., left by a prior aborted run)
- **THEN** the pipeline SHALL remove the symlink via `fs.unlink` and emit a log message identifying the removed path
- **AND** the symlink SHALL NOT be present when the dependency install step or any harness runs

#### Scenario: node_modules directory is not removed during bootstrap
- **WHEN** a `node_modules` directory (not a symlink) exists at the worktree root at bootstrap time
- **THEN** the pipeline SHALL NOT remove it
- **AND** SHALL treat it as a legitimately-installed dependency tree and skip the install step per the idempotency rule in `worktree-dependency-install`

#### Scenario: worktree is dependency-installed before first use
- **WHEN** a worktree is freshly created for an issue
- **THEN** the dependency install step SHALL run inside that worktree before `createWorktree` returns
- **AND** all subsequent stages SHALL be able to invoke binaries that the install step provides
