# worktree-lifecycle Specification

## Purpose
How the pipeline isolates each issue's work in a dedicated git worktree, bounds concurrency to active work, serializes runs with a PID lock, honors an emergency kill-switch, and bootstraps the GitHub labels the state machine depends on. (Removal of merged-PR worktrees is refined by `worktree-stale-cleanup`.)
## Requirements
### Requirement: Deterministic worktree path and branch naming
Each issue SHALL get a worktree at `<repo>/<cfg.worktree_root>/pipeline-<issueN>-<slug>` on branch `pipeline/<issueN>-<slug>`, where `<slug>` is a URL-safe, length-bounded slug of the issue title.

#### Scenario: naming
- **WHEN** a worktree is created for issue 42 with a slugged title
- **THEN** its path SHALL be `<repo>/<worktree_root>/pipeline-42-<slug>` and its branch SHALL be `pipeline/42-<slug>`

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

### Requirement: PID-based lock with stale recovery
A run SHALL hold a per-domain (optionally per-issue) lock at `/tmp/pipeline-<domain>[-<issueN>].lock`, acquired with an atomic create-or-fail. If the lock file exists, its PID SHALL be probed; a dead or invalid PID SHALL be treated as stale, removed, and the lock re-acquired.

#### Scenario: stale lock recovered
- **WHEN** the lock file holds a PID for a process that is no longer running
- **THEN** the lock SHALL be reclaimed and the run SHALL proceed

#### Scenario: live lock respected
- **WHEN** the lock file holds a PID of a running process
- **THEN** acquisition SHALL fail and the new run SHALL not proceed concurrently

### Requirement: Kill switch halts execution
When the file `/tmp/pipeline-<domain>.disabled` exists, the pipeline SHALL exit without running any stage.

#### Scenario: kill switch active
- **WHEN** `/tmp/pipeline-<domain>.disabled` exists at the start of a run
- **THEN** the pipeline SHALL exit without dispatching any stage

### Requirement: Pipeline labels are bootstrapped idempotently
`ensurePipelineLabels` SHALL idempotently create the labels the state machine relies on: `blocked`, the `harness:*` labels, and one `pipeline:<stage>` label per entry in `STAGES`. Re-running SHALL create no duplicates.

#### Scenario: labels ensured
- **WHEN** `ensurePipelineLabels` runs against a repo missing some pipeline labels
- **THEN** the missing labels SHALL be created and already-present labels SHALL be left unchanged

