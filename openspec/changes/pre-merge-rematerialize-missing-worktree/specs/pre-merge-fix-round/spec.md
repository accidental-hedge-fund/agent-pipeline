## ADDED Requirements

### Requirement: Pre-merge auto-fix SHALL rematerialize a missing managed worktree before implementer work

When the pre-merge auto-fix path is eligible (allowlisted subset non-empty, implementer harness configured, no prior auto-fix attempt marker at the entry head) — including residual re-entry auto-fix after a prior park via `reuseBlockedBy` / `enforceReviewShaGate` — and the issue’s managed worktree is not on disk, the pipeline SHALL attempt rematerialize via `ensureManagedWorktree` (see `worktree-rematerialize`) before invoking the implementer harness or returning an auto-fix failure status.

On rematerialize success, auto-fix SHALL proceed with the recreated path. On rematerialize failure, the path SHALL surface a typed worktree / rematerialize failure — via a distinct autofix result (`rematerialize-failed` carrying the seam's `blockerKind`) — with a diagnostic that names the rematerialize failure. `enforceReviewShaGate` (residual re-entry and normal delta autofix routing) SHALL park with that worktree blocker kind (`worktree-missing`, `worktree-creation-failed`, or `worktree-capacity`). It SHALL NOT collapse rematerialize failure into a bare `{ status: "error" }` that is indistinguishable from product residual judgment, and SHALL NOT use a product `needs-human` park whose sole root cause is rematerialize failure after a missing tree.

Both the normal delta-review autofix path and the residual re-entry path SHALL share the same production autofix closure (or the same injected seam) so rematerialize cannot be wired for one entry and omitted for the other.

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
- **THEN** the auto-fix path SHALL fail with status `rematerialize-failed` (or equivalent typed result) carrying the seam's worktree `blockerKind` and a diagnostic naming rematerialize / worktree creation failure
- **AND** `enforceReviewShaGate` residual re-entry SHALL `setBlocked` / return blocked with that worktree kind — not bare `needs-human`
- **AND** a durable rematerialize fail event SHALL be recorded when a run dir is present
- **AND** the failure SHALL NOT be a bare empty `{ status: "error" }` with no rematerialize diagnostic

#### Scenario: Present worktree skips rematerialize and runs autofix as today

- **WHEN** auto-fix is eligible and a managed worktree is already on disk
- **THEN** the pipeline SHALL NOT recreate the worktree solely for auto-fix
- **AND** SHALL run the existing bounded auto-fix attempt on that path

#### Scenario: Normal delta autofix shares the same rematerialize seam

- **WHEN** the normal pre-merge delta auto-fix path is eligible and the worktree is missing
- **THEN** the same `ensureManagedWorktree` seam used by residual re-entry SHALL run before implementer work
