## MODIFIED Requirements

### Requirement: Reconciliation SHALL observe live external truth through an engine-owned seam

Reconciliation SHALL derive observed truth by reading live forge, git, CI-checks, and managed-
worktree state through engine-owned typed observation seams and SHALL NOT accept a caller-supplied
truth document as authoritative. The supervisor SHALL run a full reconciliation at each cycle
boundary and SHALL perform a fresh typed identity observation after a blocked dispatch,
immediately before and after a recovery side effect, and before persisting a human hold or remote-
proving completion. Each full pass SHALL record `last_reconciliation` with a monotonically
increasing sequence number, observation time, and authoritative candidate identity and SHALL emit
a reconciliation event under the run lock. Recovery-boundary observations SHALL be persisted on
the item and emitted as recovery reconciliation events under the same lock. The seams SHALL be
injectable so tests perform no real network, git, or subprocess calls.

#### Scenario: Truth comes from the live remote, not the caller

- **WHEN** a caller claims an item is merged while the injected live observation reports its PR is
  still open
- **THEN** reconciliation SHALL record the live-observed state, not the caller's claim
- **AND** the item's ledger state SHALL NOT be changed to merged

#### Scenario: Reconciliation performs no real I/O under test

- **WHEN** reconciliation runs through injected observation seams
- **THEN** zero real network, git, and subprocess calls SHALL be recorded

#### Scenario: Reconciliations are sequenced and eventful

- **WHEN** reconciliation runs repeatedly
- **THEN** each SHALL record a sequence number one greater than the previous plus the observed
  candidate identity
- **AND** each SHALL emit a reconciliation event under the lock token

#### Scenario: Dispatch result is reconciled before disposition

- **WHEN** a whole-item dispatch returns blocked, failed, or ready-to-deploy
- **THEN** the supervisor SHALL observe fresh live truth before persisting recovery, hold,
  remote-proving completion, or stop
- **AND** the resulting decision SHALL bind to the reconciled candidate identity

#### Scenario: Candidate movement supersedes a stale recovery claim

- **WHEN** reconciliation before a recovery side effect observes a candidate identity different
  from the claim's identity
- **THEN** the old attempt SHALL NOT execute against or complete as recovery of the new candidate
- **AND** the controller SHALL recompute disposition from the new current state

### Requirement: Reconciliation SHALL compute a deterministic next action per active item

Reconciliation SHALL compute from reconciled item state and verified external identity exactly one
next action from the closed `LoopNextAction` set: `advance`, `await-checks`, `repair-forward`,
`clear-merge-barrier`, `hold-for-human`, or `noop`. The computation SHALL be pure and deterministic.
`hold-for-human` SHALL require a current canonical `human-decision-required` diagnostic associated
with the reconciled block. Contradiction, missing diagnostic, identity mismatch, and exhausted
mechanical recovery SHALL NOT project to `hold-for-human` without that evidence.

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
- **THEN** its computed next action SHALL be `noop`
- **AND** it SHALL NOT be `hold-for-human`

#### Scenario: The computation is deterministic

- **WHEN** next-action computation runs twice on identical reconciled state and identity inputs
- **THEN** it SHALL return the identical action both times
