# worktree-per-run-removal Specification

## Purpose
TBD - created by archiving change worktree-merged-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Per-issue worktree removal via flag
The pipeline SHALL accept a `--remove-worktree` flag on `pipeline N` invocations. When supplied, the pipeline SHALL locate the on-disk worktree for issue N, remove it (worktree directory deregistered from git AND local branch deleted), and exit without running any pipeline-advance logic. The remote branch SHALL NOT be touched.

#### Scenario: Clean worktree is removed
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a pipeline-managed worktree for issue N exists on disk
- **AND** the worktree has no uncommitted changes (`git status --porcelain` returns empty)
- **THEN** the worktree directory is removed from disk
- **AND** `git worktree list` no longer includes the worktree
- **AND** the local branch `pipeline/<N>-<slug>` is deleted
- **AND** the remote branch is NOT deleted or modified
- **AND** the process exits zero

#### Scenario: No worktree found exits non-zero
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** no pipeline-managed worktree for issue N exists on disk
- **THEN** an error is printed naming issue N
- **AND** the process exits non-zero

#### Scenario: Command works regardless of PR merge state
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a worktree for issue N is present on disk
- **AND** the PR for issue N is open (not yet merged)
- **THEN** the worktree is removed (same behavior as if the PR were merged)
- **AND** the process exits zero (assuming the worktree is clean)

---

### Requirement: Dirty worktree blocks removal without --force
The pipeline SHALL NOT silently destroy uncommitted work. If the worktree for issue N has uncommitted local changes (tracked or untracked modifications) and `--force` is not supplied, the pipeline SHALL exit non-zero and report the dirty state. The worktree SHALL NOT be removed.

#### Scenario: Dirty worktree without --force exits non-zero
- **WHEN** the operator invokes `pipeline N --remove-worktree` without `--force`
- **AND** a worktree for issue N exists
- **AND** `git status --porcelain` in the worktree returns non-empty output
- **THEN** the worktree is NOT removed
- **AND** the local branch is NOT deleted
- **AND** an error is printed indicating uncommitted changes
- **AND** the process exits non-zero

#### Scenario: Dirty worktree with --force is removed with warning
- **WHEN** the operator invokes `pipeline N --remove-worktree --force`
- **AND** a worktree for issue N exists with uncommitted changes
- **THEN** a warning is logged indicating the worktree had uncommitted changes
- **AND** the worktree directory is removed
- **AND** the local branch is deleted
- **AND** the remote branch is NOT touched
- **AND** the process exits zero

---

### Requirement: JSON output for machine-readable consumers
When `--json` is combined with `--remove-worktree`, the pipeline SHALL emit a single JSON object to stdout (and nothing else) with at least the following fields: `removed` (boolean), `dirty` (boolean), `branch` (string or null), `worktree` (string or null), `error` (string or null). The exit code rules are unchanged.

#### Scenario: Successful removal with --json
- **WHEN** the operator invokes `pipeline N --remove-worktree --json`
- **AND** the worktree is clean and is removed
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `true`, `dirty` is `false`, `error` is `null`
- **AND** `branch` is the branch name that was deleted
- **AND** `worktree` is the path that was removed
- **AND** the process exits zero

#### Scenario: Dirty worktree with --json (no --force)
- **WHEN** the operator invokes `pipeline N --remove-worktree --json` without `--force`
- **AND** the worktree is dirty
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `false`, `dirty` is `true`
- **AND** `error` describes the uncommitted-changes condition
- **AND** the process exits non-zero

#### Scenario: Not-found with --json
- **WHEN** the operator invokes `pipeline N --remove-worktree --json`
- **AND** no worktree for issue N exists
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `false`, `worktree` is `null`, `branch` is `null`
- **AND** `error` describes the not-found condition
- **AND** the process exits non-zero

---

### Requirement: Kill-switch bypass
`pipeline N --remove-worktree` SHALL bypass the kill switch. A kill switch active during a stuck run is precisely when operators most need to clean up worktrees; blocking this action with the kill switch would prevent recovery.

#### Scenario: --remove-worktree succeeds despite active kill switch
- **WHEN** the kill switch file `/tmp/pipeline-<domain>.disabled` exists
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** the removal proceeds normally (not blocked by the kill switch)

---

### Requirement: --force requires --remove-worktree
Using `--force` without `--remove-worktree` SHALL be a usage error. The `--force` modifier is scoped to the per-issue removal mode and has no meaning in other pipeline modes.

#### Scenario: --force alone exits with usage error
- **WHEN** the operator invokes `pipeline N --force` without `--remove-worktree`
- **THEN** the process exits non-zero with a usage error naming the invalid flag combination
- **AND** no pipeline-advance logic runs

---

### Requirement: Unit-testable via injectable deps
The per-issue removal logic SHALL be implemented with an injectable `RemoveWorktreeDeps` interface (following the `SweepDeps` / `CreateWorktreeDeps` pattern). Unit tests SHALL exercise all outcomes (clean removal, dirty-without-force, dirty-with-force, not-found) using fake deps with no real git, network, or filesystem calls.

#### Scenario: All outcomes exercised without real I/O
- **WHEN** the test suite runs `removeWorktreeForIssue` with fake deps
- **THEN** each outcome path (removed, blocked-dirty, forced-dirty, not-found) is covered by at least one test
- **AND** no real `git` subprocess, filesystem write, or network call is made

