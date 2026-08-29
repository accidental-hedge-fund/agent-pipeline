## MODIFIED Requirements

### Requirement: Capacity policy is documented for operators

Operator-facing documentation (README and/or durable-loop section) SHALL state: (1) what counts toward `max_concurrent_worktrees` (on-disk managed worktrees for open issues that are not `pipeline:ready-to-deploy`); (2) that durable park releases safe worktrees and retains unsafe ones; (3) that pure capacity is an ops admission disposition, not product needs-human; (4) that `pipeline cleanup` / merge-only sweep does not free open blocked-PR worktrees and how to recover retained trees (e.g. push then re-park, or `pipeline N --remove-worktree` when safe).

#### Scenario: Docs name capacity count and park-release

- **WHEN** an operator reads the documented capacity policy
- **THEN** the docs SHALL name the active count rule, park-release vs retain, capacity vs product needs-human, and merge-only cleanup limits
