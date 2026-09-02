## ADDED Requirements

### Requirement: Cleanup SHALL preserve unknown state and SHALL NOT interfere with a fenced live owner

`pipeline cleanup` SHALL remain bounded-atomic administration. It SHALL remove only pipeline-managed worktrees whose associated PR is merged, that are clean, whose state is classified, and that are not held by a fenced live owner. A fenced live owner SHALL be the unified issue-run lock with a live PID or the live-planning marker for that repository and issue. Cleanup SHALL skip unknown or unclassified worktree state and SHALL include each skip in the skipped report with a reason. Cleanup SHALL NOT create, cancel, or take RecoverySupervisor ownership of a run. A crash or failure SHALL leave any live run owned.

#### Scenario: Unknown worktree state is skipped

- **WHEN** cleanup finds a pipeline-managed path whose PR-merge state, dirtiness, or ownership cannot be classified
- **THEN** the worktree SHALL NOT be removed
- **AND** it SHALL appear in the skipped list with a reason that names unknown or unclassified state

#### Scenario: Fenced live owner is skipped

- **WHEN** a worktree's PR is merged
- **AND** a fenced live owner holds the issue-run lock or live-planning marker
- **THEN** the worktree SHALL NOT be removed
- **AND** the live run SHALL remain owned
- **AND** the worktree SHALL appear in the skipped list with a live-owner reason

#### Scenario: Classified merged clean worktree without a live owner is removed

- **WHEN** a pipeline-managed worktree has a merged PR
- **AND** the worktree is clean
- **AND** no fenced live owner holds it
- **AND** its state is classified
- **THEN** the worktree SHALL be removed as specified by existing merged-PR cleanup
