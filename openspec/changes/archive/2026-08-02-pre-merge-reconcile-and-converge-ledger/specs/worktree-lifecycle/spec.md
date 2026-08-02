## ADDED Requirements

### Requirement: Create, reclaim, and reuse decisions SHALL consume worktree reconcile actions

`createWorktree` and other lifecycle entry points SHALL obtain retain/reclaim/recreate decisions
from the worktree reconcile-and-converge surface (or a thin wrapper around it) rather than
re-encoding independent dirty/local-only/poisoned-tree branches at each call site. Automatic reclaim
mutation safety (non-force remove, compare-and-delete branch tip) remains as already required;
reconcile SHALL NOT weaken those guards.

#### Scenario: Lifecycle entry uses reconcile rather than a private decision tree

- **WHEN** `createWorktree` runs for an issue that may already have a managed worktree or path
  collision
- **THEN** retain/reclaim/recreate selection SHALL come from the shared worktree reconcile surface
- **AND** a dirty or local-only candidate SHALL still refuse reclaim without force

#### Scenario: Reconcile refuse blocks create without destroying the tree

- **WHEN** reconcile returns refuse-unsafe-remove for the existing managed candidate
- **THEN** `createWorktree` SHALL abort without removing that worktree or its branch
- **AND** SHALL NOT create a second worktree at the target path in the same call
