## ADDED Requirements

### Requirement: Worktree-missing sites dispositioned transient-retryable SHALL rematerialize before parking

Worktree-missing sites dispositioned `transient-retryable` SHALL rematerialize before parking.
Production fix, pre-merge, and other stage paths that currently park with `worktree-missing`
when the managed tree is absent SHALL invoke the existing rematerialize /
`ensureManagedWorktree` seam (after dirty-work and local-only safety checks) before calling
`setBlocked` for absence. Successful rematerialization SHALL allow the stage to continue.
Failure SHALL block with the seam's typed worktree kind (`worktree-missing`,
`worktree-creation-failed`, or `worktree-capacity`) and a canonical engine-owned reason — not
bare product `needs-human`.

This requirement extends coverage to inventory-listed sites that still first-hop to
`worktree-missing` without rematerialize; it does not weaken #622 dirty/local-only reclaim
refusals.

#### Scenario: Missing tree rematerializes on a dispositioned fix path

- **WHEN** a fix path dispositioned `transient-retryable` requires a managed worktree
- **AND** on-disk lookup returns no worktree
- **AND** open-PR head or verified remote tip is recoverable and create succeeds
- **THEN** the stage SHALL continue on the rematerialized worktree
- **AND** SHALL NOT call `setBlocked` solely for the initial absence

#### Scenario: Dirty reclaim refuse stays typed

- **WHEN** rematerialize would destroy a dirty or local-only unpushed candidate
- **THEN** the seam SHALL refuse
- **AND** the stage SHALL block with a typed worktree creation failure
- **AND** SHALL NOT force-remove the candidate

#### Scenario: Capacity remains capacity

- **WHEN** rematerialize fails solely because `max_concurrent_worktrees` is saturated
- **THEN** the block kind SHALL be the capacity kind
- **AND** disposition/metrics SHALL treat it as capacity, not product judgment
)