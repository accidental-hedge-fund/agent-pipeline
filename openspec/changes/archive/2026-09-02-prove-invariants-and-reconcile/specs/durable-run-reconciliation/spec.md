## MODIFIED Requirements

### Requirement: Reconciliation SHALL repair only benign forward drift and surface contradictions

Reconciliation SHALL repair `ledger-behind` drift by applying the catch-up transition to the
externally verified state as an audited ledger update that appends a history entry and emits an
event. For `ledger-ahead`, `external-absent`, or `identity-mismatch` drift without independent
typed-request evidence, reconciliation SHALL reconstruct durable local ledger, claim, and last-verified
identity from the owning-system observer, append a history entry, emit an event, and keep the item
RecoverySupervisor-owned. Reconciliation SHALL NOT route those contradictions to a human. No repair
or reconstruction path SHALL perform any external mutation — no merge, push, label write, PR edit,
release, or deploy.

#### Scenario: Benign catch-up drift is repaired forward

- **WHEN** an item's `ledger-behind` drift shows the PR verified as `merged`
- **THEN** reconciliation SHALL transition the item forward to `merged` with a history entry and an
  event
- **AND** no external mutation SHALL be recorded through the injected seam

#### Scenario: An over-claim is surfaced, never silently resolved

- **WHEN** an item has `ledger-ahead` drift (the ledger claims a remote state the identity does not
  support)
- **AND** no current canonical `human-decision-required` diagnostic exists
- **THEN** reconciliation SHALL reconstruct the local ledger to match the verified identity
- **AND** SHALL record the drift
- **AND** the item SHALL remain RecoverySupervisor-owned
- **AND** the next action SHALL NOT be `hold-for-human`
- **AND** no external mutation SHALL be recorded through the injected seam

#### Scenario: Repair never mutates the remote

- **WHEN** any repair path is exercised through the injected seam
- **THEN** no GitHub write, git push, label change, or PR edit SHALL be recorded

---

### Requirement: Reconciliation SHALL compute a deterministic next action per active item

Reconciliation SHALL compute from reconciled item state and verified external identity exactly one
next action from the closed `LoopNextAction` set: `advance`, `await-checks`, `repair-forward`,
`reconstruct`, `clear-merge-barrier`, `hold-for-human`, or `noop`. The computation SHALL be pure and
deterministic. `hold-for-human` SHALL require a current canonical `human-decision-required`
diagnostic associated with the reconciled block. Contradiction, missing diagnostic, identity
mismatch, and exhausted mechanical recovery SHALL NOT project to `hold-for-human` without that
evidence. `ledger-ahead`, `external-absent`, and `identity-mismatch` without that evidence SHALL
compute `reconstruct`. `noop` SHALL mean aligned and idle, not contradiction.

#### Scenario: Pending checks yield await-checks

- **WHEN** an item is aligned at `pr_opened` and its verified `checks_conclusion` is `pending`
- **THEN** its computed next action SHALL be `await-checks`

#### Scenario: Current authority evidence yields hold-for-human

- **WHEN** an item has a current canonical `human-decision-required` diagnostic for the reconciled
  block
- **THEN** its computed next action SHALL be `hold-for-human`

#### Scenario: A contradiction does not invent human authority

- **WHEN** an item has `ledger-ahead`, `external-absent`, or `identity-mismatch` drift without a
  current human-decision diagnostic
- **THEN** its computed next action SHALL be `reconstruct`
- **AND** it SHALL NOT be `hold-for-human`
- **AND** it SHALL NOT be `noop`

#### Scenario: The computation is deterministic

- **WHEN** next-action computation runs twice on identical reconciled state and identity inputs
- **THEN** it SHALL return the identical action both times
