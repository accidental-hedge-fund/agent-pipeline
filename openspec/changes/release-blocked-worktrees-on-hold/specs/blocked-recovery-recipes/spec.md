## ADDED Requirements

### Requirement: Worktree capacity has a distinct blocker kind and ops recipe

The `BlockerKind` closed set SHALL include a distinct member for pure worktree capacity admission failure (for example `worktree-capacity`, exact string locked by implementation tests) that is separate from product `needs-human` and from generic `worktree-creation-failed`. When capacity is the sole create failure, `setBlocked` (or the equivalent outcome path) SHALL use that capacity kind. The associated `BLOCKER_RECIPES` entry SHALL instruct the operator to wait for an active issue to complete or for safe park-release to free a slot, and MAY mention manual safe remove of retained parked worktrees; it SHALL NOT present product-override language or “answer findings / product judgment” as the primary unblock path. Snapshot or string-assertion coverage for recipes SHALL include the capacity kind.

#### Scenario: Capacity kind is not needs-human

- **WHEN** create fails solely because other active worktrees are at `max_concurrent_worktrees`
- **AND** the outcome is recorded with a `BlockerKind`
- **THEN** the kind SHALL be the capacity kind, not `needs-human`

#### Scenario: Capacity recipe is ops-oriented

- **WHEN** the capacity kind's recipe text is rendered
- **THEN** it SHALL describe waiting for capacity or freeing retained parked worktrees
- **AND** it SHALL NOT use the product needs-human override recipe as its primary text

#### Scenario: Recipe map covers the capacity kind

- **WHEN** `BLOCKER_RECIPES` is inspected at runtime
- **THEN** it SHALL contain a non-empty entry for the capacity kind
- **AND** the capacity kind SHALL be a member of the `BlockerKind` enum
