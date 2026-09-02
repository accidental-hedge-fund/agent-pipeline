## MODIFIED Requirements

### Requirement: Durable loop SHALL NOT cascade per-item capacity human blocks

When a durable multi-item loop would schedule further pending items and the only barrier to starting them is worktree capacity, the supervisor SHALL NOT mark each remaining pending item as a product `blocked` / needs-human hold in sequence solely for capacity. After park-release has freed safe parked slots, new starts MAY proceed within the cap. If residual capacity is still full because true-active (non-parked) worktrees occupy every slot, RecoverySupervisor SHALL persist owned Cooling or an external-condition wait with a clear capacity reason and a future `next_eligible_at`. It SHALL preserve already-ready and already-held sibling state without inventing product human answer requests for pure capacity. Residual capacity SHALL NOT persist `worktree_capacity` as a lifecycle terminal stop.

#### Scenario: Park-release frees a slot for the next pending item

- **WHEN** `max_concurrent_worktrees` is N
- **AND** N issues have durable-parked with safe release preconditions met (worktrees released)
- **AND** a further dependency-ready pending item is selected
- **THEN** creating a worktree for that item SHALL NOT fail solely because the parked issues still occupy capacity
- **AND** the item SHALL NOT be recorded as product needs-human solely for capacity

#### Scenario: Residual true-active capacity stops admission without cascade

- **WHEN** every capacity slot is held by non-parked active worktrees
- **AND** one or more pending items remain schedulable by dependency rules alone
- **THEN** RecoverySupervisor SHALL persist Cooling or an external-condition wait with a capacity reason
- **AND** it SHALL NOT sequentially label each remaining pending item product-blocked for capacity alone
- **AND** it SHALL NOT persist `worktree_capacity` as a lifecycle terminal stop
- **AND** already-active siblings SHALL remain owned

#### Scenario: Product needs-human holds are unchanged

- **WHEN** an item parks for a genuine product or review needs-human reason unrelated to capacity
- **THEN** existing needs-human hold disposition and recipes SHALL apply unchanged
- **AND** this requirement SHALL NOT reclassify those holds as capacity admission
