## ADDED Requirements

### Requirement: Remove-worktree SHALL refuse a fenced live owner

`pipeline N --remove-worktree` and `pipeline remove-worktree` SHALL refuse to remove a worktree held by a fenced live owner. A fenced live owner SHALL be the unified issue-run lock with a live PID or the live-planning marker for that repository and issue. `--force` SHALL NOT override the live-owner fence. The command SHALL remain bounded-atomic administration: it SHALL NOT take RecoverySupervisor ownership of the live run. On refusal the process SHALL exit non-zero, the worktree SHALL remain, and the live run SHALL remain owned.

#### Scenario: Live owner blocks clean removal

- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a pipeline-managed worktree for issue N exists and is clean
- **AND** a fenced live owner holds the issue
- **THEN** no `git worktree remove` and no `git branch -D` SHALL be invoked
- **AND** the process SHALL exit non-zero
- **AND** the live run SHALL remain owned

#### Scenario: Force does not evict a live owner

- **WHEN** the operator invokes `pipeline N --remove-worktree --force`
- **AND** a fenced live owner holds the issue
- **THEN** the worktree SHALL NOT be removed
- **AND** the process SHALL exit non-zero
