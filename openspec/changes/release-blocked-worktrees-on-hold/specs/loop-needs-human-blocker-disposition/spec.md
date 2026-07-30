## ADDED Requirements

### Requirement: Pure capacity outcomes SHALL NOT become needs-human product holds

The supervisor's needs-human hold path (per-item `paused`/`waiting` holds for product or review blockers that require a human answer) SHALL NOT absorb pure worktree capacity admission failures as if they were product-judgment needs-human outcomes. When a dispatch or planning create fails solely for worktree capacity, the supervisor SHALL route that outcome to capacity admission handling (see `worktree-capacity-admission`) — stop or hold admission with a capacity reason, or allow a later cycle after park-release frees slots — and SHALL NOT record a product needs-human hold that requests a human answer for that capacity-only case. Genuine `pipeline:blocked` product/review holds and genuine `blocked_needs_human` product outcomes remain needs-human holds as already specified.

#### Scenario: Capacity-only planning failure is not a product needs-human hold

- **WHEN** an item's dispatch fails in planning solely with a worktree capacity error
- **AND** no product or review needs-human condition is present
- **THEN** the supervisor SHALL NOT classify the item as a product needs-human hold that requests a human answer
- **AND** SHALL apply capacity admission disposition instead

#### Scenario: Genuine blocked product hold is unchanged

- **WHEN** an item carries `pipeline:blocked` for a product or review reason unrelated to capacity
- **THEN** the supervisor SHALL still record a needs-human hold per existing requirements
- **AND** SHALL NOT reclassify that hold as capacity admission solely because capacity is also tight in the fleet
