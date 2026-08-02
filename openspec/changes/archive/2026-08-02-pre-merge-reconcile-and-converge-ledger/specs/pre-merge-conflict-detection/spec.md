## ADDED Requirements

### Requirement: Early-conflict rebase bounds SHALL use the stage-attempt ledger

The pre-merge early-conflict rebase path SHALL bound attempts using the stage-attempt ledger keyed
by PR head SHA and rebase action, not by the presence of a worktree-local
`.pipeline-rebase-attempted` file as sole authority. One-shot and block-after-attempt product
outcomes remain: first eligible conflict may attempt rebase; an already-recorded attempt for the
same head SHALL block with a merge-conflict manual-rebase reason rather than loop.

#### Scenario: First conflict on head H attempts rebase and claims the ledger

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** the ledger has no completed or started rebase attempt for the current head SHA `H`
- **THEN** the gate SHALL claim the rebase action for `H` and invoke `tryRebaseAndPush`
- **AND** SHALL NOT rely on creating `.pipeline-rebase-attempted` as the durable bound

#### Scenario: Ledger-recorded rebase attempt blocks loop without worktree marker

- **WHEN** the pre-merge gate detects CONFLICTING mergeability
- **AND** the ledger already records a rebase attempt for the current head SHA
- **AND** no `.pipeline-rebase-attempted` file is present
- **THEN** the gate SHALL NOT invoke `tryRebaseAndPush` again for that head
- **AND** SHALL call `setBlocked` with a merge-conflict manual-rebase reason
