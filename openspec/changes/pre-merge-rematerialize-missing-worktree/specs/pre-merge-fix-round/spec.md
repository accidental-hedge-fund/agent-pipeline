## ADDED Requirements

### Requirement: Pre-merge auto-fix SHALL rematerialize a missing managed worktree before implementer work

When the pre-merge auto-fix path is eligible (allowlisted subset non-empty, implementer harness configured, no prior auto-fix attempt marker at the entry head) — including residual re-entry auto-fix after a prior park — and the issue’s managed worktree is not on disk, the pipeline SHALL attempt rematerialize (see `worktree-rematerialize`) before invoking the implementer harness or returning an auto-fix `error` status. On rematerialize success, auto-fix SHALL proceed with the recreated path. On rematerialize failure, the path SHALL surface a typed worktree / rematerialize failure (not a silent bare `error` that is indistinguishable from product residual judgment, and not a product `needs-human` park whose sole root cause is a missing tree when rematerialize was not attempted).

#### Scenario: Residual re-entry autofix rematerializes then runs implementer

- **WHEN** residual re-entry auto-fix is eligible for an allowlisted blocking subset
- **AND** on-disk worktree lookup returns no worktree
- **AND** rematerialize succeeds
- **THEN** the pipeline SHALL invoke the auto-fix path with the recreated worktree
- **AND** SHALL NOT return auto-fix `error` solely because the worktree was initially missing

#### Scenario: Missing worktree blocks residual autofix only after rematerialize fails

- **WHEN** residual re-entry auto-fix is eligible
- **AND** on-disk worktree lookup returns no worktree
- **AND** rematerialize fails
- **THEN** the auto-fix path SHALL fail with a diagnostic naming rematerialize / worktree creation failure
- **AND** a durable rematerialize fail event SHALL be recorded when a run dir is present

#### Scenario: Present worktree skips rematerialize and runs autofix as today

- **WHEN** auto-fix is eligible and a managed worktree is already on disk
- **THEN** the pipeline SHALL NOT recreate the worktree solely for auto-fix
- **AND** SHALL run the existing bounded auto-fix attempt on that path
