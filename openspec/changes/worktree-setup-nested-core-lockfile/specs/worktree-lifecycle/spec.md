## MODIFIED Requirements

### Requirement: Worktree created off the latest base; stale path reclaimed
`createWorktree` SHALL fetch and branch off the latest `origin/<base_branch>`. Before creating the new worktree, the pipeline SHALL reclaim same-issue managed worktrees and clear a colliding directory at the target path **only when reclaim safety checks pass** (see Requirement: Create-time reclaim SHALL share operator remove safety). When reclaim is refused, `createWorktree` SHALL abort without creating a new worktree and without destroying the existing worktree or branch. After a git worktree is successfully created, the pipeline SHALL: (1) write the `node_modules` staging exclusion to `.git/info/exclude` inside the worktree, (2) remove any pre-existing `node_modules` symlink at the worktree root and log the removal, and (3) execute the dependency install step (as specified in `worktree-dependency-install`) before control returns to the caller, so that every worktree is fully bootstrapped and runnable from the moment it is created.

#### Scenario: clean stale path is reclaimed
- **WHEN** a directory already exists at the target worktree path
- **AND** the candidate is a managed worktree (or path collision under the managed root) with a clean workdir and no local-only commits
- **THEN** it SHALL be removed before the new worktree is created off `origin/<base_branch>`

#### Scenario: dirty stale path is not force-reclaimed
- **WHEN** a managed worktree already exists for the same issue (or at the target path)
- **AND** `git status --porcelain` in that worktree returns non-empty output
- **THEN** `createWorktree` SHALL NOT remove the worktree or delete its local branch
- **AND** SHALL abort with an error naming the dirty condition
- **AND** no new worktree SHALL be created at the target path for this call

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
- **AND** SHALL skip the install step only when the detected package root already has `node_modules`, per the idempotency rule in `worktree-dependency-install`

#### Scenario: root node_modules does not suppress nested core/ install
- **WHEN** a `node_modules` directory (not a symlink) exists at the worktree root at bootstrap time
- **AND** the worktree root contains no recognized lockfile
- **AND** `<worktree>/core/package-lock.json` exists
- **AND** `<worktree>/core/node_modules` does not exist
- **AND** `setup_command` is not set
- **THEN** the pipeline SHALL NOT remove the root `node_modules` directory
- **AND** SHALL still run `npm ci` with CWD `<worktree>/core`

#### Scenario: worktree is dependency-installed before first use
- **WHEN** a worktree is freshly created for an issue
- **THEN** the dependency install step SHALL run inside that worktree before `createWorktree` returns
- **AND** all subsequent stages SHALL be able to invoke binaries that the install step provides
