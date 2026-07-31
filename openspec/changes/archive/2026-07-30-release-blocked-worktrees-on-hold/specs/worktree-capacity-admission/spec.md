## ADDED Requirements

### Requirement: Pure worktree capacity SHALL be an ops admission disposition, not product needs-human

When the sole reason an issue cannot start or obtain a worktree is that `otherActive` managed worktrees already meet `cfg.max_concurrent_worktrees`, the pipeline SHALL treat that outcome as an **ops/capacity admission** failure — not as a product-judgment needs-human decision that requests a human answer, override, or product disposition. The outcome SHALL be machine-distinguishable from product `needs-human` (a dedicated capacity kind, error identity, or equivalent typed field locked by tests). Operator-facing text SHALL state that capacity is full, that the operator should wait for active work to complete or for safe park-release to free slots, and SHALL NOT use product-override / “answer the findings” recipe language for that pure-capacity case.

#### Scenario: Capacity error is not product needs-human

- **WHEN** `createWorktree` refuses solely because other active worktrees are at `max_concurrent_worktrees`
- **THEN** the recorded disposition SHALL be capacity/ops admission, not product-judgment `needs-human`
- **AND** blocker or hold text SHALL distinguish capacity/ops from product needs-human

#### Scenario: Capacity kind is machine-distinguishable

- **WHEN** a pure capacity refusal is recorded on a run or issue outcome
- **THEN** tests and consumers SHALL be able to identify it via a stable typed kind or error identity without scraping free text alone

### Requirement: Durable loop SHALL NOT cascade per-item capacity human blocks

When a durable multi-item loop would schedule further pending items and the only barrier to starting them is worktree capacity, the supervisor SHALL NOT mark each remaining pending item as a product `blocked` / needs-human hold in sequence solely for capacity. After park-release has freed safe parked slots, new starts MAY proceed within the cap. If residual capacity is still full because true-active (non-parked) worktrees occupy every slot, the run SHALL stop admitting new starts with a clear capacity / `worktree_capacity` (or equivalent) run-level or admission reason and SHALL preserve already-ready and already-held sibling state without inventing product human answer requests for pure capacity.

#### Scenario: Park-release frees a slot for the next pending item

- **WHEN** `max_concurrent_worktrees` is N
- **AND** N issues have durable-parked with safe release preconditions met (worktrees released)
- **AND** a further dependency-ready pending item is selected
- **THEN** creating a worktree for that item SHALL NOT fail solely because the parked issues still occupy capacity
- **AND** the item SHALL NOT be recorded as product needs-human solely for capacity

#### Scenario: Residual true-active capacity stops admission without cascade

- **WHEN** every capacity slot is held by non-parked active worktrees
- **AND** one or more pending items remain schedulable by dependency rules alone
- **THEN** the durable loop SHALL stop or hold admission with a capacity reason
- **AND** it SHALL NOT sequentially label each remaining pending item product-blocked for capacity alone

#### Scenario: Product needs-human holds are unchanged

- **WHEN** an item parks for a genuine product or review needs-human reason unrelated to capacity
- **THEN** existing needs-human hold disposition and recipes SHALL apply unchanged
- **AND** this requirement SHALL NOT reclassify those holds as capacity admission

### Requirement: Capacity policy is documented for operators

Operator-facing documentation (README and/or durable-loop section) SHALL state: (1) what counts toward `max_concurrent_worktrees` (on-disk managed worktrees for open issues that are not `pipeline:ready-to-deploy`); (2) that durable park releases safe worktrees and retains unsafe ones; (3) that pure capacity is an ops admission disposition, not product needs-human; (4) that `pipeline:cleanup` / merge-only sweep does not free open blocked-PR worktrees and how to recover retained trees (e.g. push then re-park, or `pipeline N --remove-worktree` when safe).

#### Scenario: Docs name capacity count and park-release

- **WHEN** an operator reads the documented capacity policy
- **THEN** the docs SHALL name the active count rule, park-release vs retain, capacity vs product needs-human, and merge-only cleanup limits
