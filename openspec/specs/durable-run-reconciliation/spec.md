# durable-run-reconciliation Specification

## Purpose
TBD - created by archiving change durable-run-reconciliation. Update Purpose after archive.
## Requirements
### Requirement: Reconciliation SHALL observe live external truth through an engine-owned seam

Reconciliation SHALL derive its observed truth by reading the live GitHub, git, and CI-checks state
itself through an engine-owned observation seam that wraps the typed `gh` wrappers and a git head
read, and SHALL NOT accept an observed-truth document supplied by the caller as authoritative. The
pass SHALL record the observation as the ledger's `last_reconciliation` with a monotonically
increasing sequence number and the observation time, and SHALL emit a reconciliation event under the
run lock token. The observation seam SHALL be injectable so unit tests supply fakes and the pass
performs no real network, git, or subprocess call.

#### Scenario: Truth comes from the live remote, not the caller

- **WHEN** a caller passes a claim document asserting an item is `merged` while the injected live
  observation reports the item's PR is still open
- **THEN** reconciliation SHALL record the live-observed state, not the caller's claim
- **AND** the item's ledger state SHALL NOT be changed to `merged`

#### Scenario: Reconciliation performs no real I/O under test

- **WHEN** reconciliation runs through the injected observation seam
- **THEN** zero real network, git, and subprocess calls SHALL be recorded

#### Scenario: Reconciliations are sequenced and eventful

- **WHEN** reconciliation runs repeatedly
- **THEN** each SHALL record `last_reconciliation` with a sequence number one greater than the
  previous
- **AND** each SHALL emit a reconciliation event under the lock token

### Requirement: Reconciliation SHALL bind each item to a structured external identity

Reconciliation SHALL express each item's observed truth as a structured `LoopExternalIdentity`
carrying the issue number, whether the issue is open, whether the ready-to-deploy label is present,
the PR number (or null), the PR state (`open`, `closed`, `merged`, or null), the head branch, the
head commit SHA, the merge-commit SHA (or null), an aggregate CI checks conclusion (`success`,
`failure`, `pending`, or `none`), and the observation time. The reconciliation record SHALL carry
this typed identity per item and SHALL NOT carry a free-form untyped observation value.

#### Scenario: An item's identity is fully typed

- **WHEN** reconciliation observes an item with an open PR whose checks are green
- **THEN** the recorded `LoopExternalIdentity` SHALL name the PR number, `pr_state` `open`, the head
  SHA, and `checks_conclusion` `success`
- **AND** the identity SHALL carry the observation time

#### Scenario: Absent external objects are represented, not omitted

- **WHEN** an item has no PR yet
- **THEN** its `LoopExternalIdentity` SHALL record `pr_number` null and `pr_state` null rather than
  omitting them

### Requirement: Reconciliation SHALL classify every drift into a closed typed set

For every item whose ledger state disagrees with its verified external identity, reconciliation SHALL
record a drift entry carrying the item id, the ledger state, the observed state, and exactly one
member of the closed `LoopDriftClass` set: `ledger-behind`, `ledger-ahead`, `external-absent`,
`identity-mismatch`, or `checks-regressed`. A drift entry with no class or a class outside this set
SHALL be impossible to record. An item whose ledger state agrees with its verified identity SHALL
produce no drift entry.

#### Scenario: External-ahead drift is classed ledger-behind

- **WHEN** the ledger records `pr_opened` but the verified identity reports the PR is `merged`
- **THEN** a drift entry SHALL be recorded with class `ledger-behind`

#### Scenario: Over-claim drift is classed as a contradiction

- **WHEN** the ledger records `merged` but the verified identity reports the PR is still `open`
- **THEN** a drift entry SHALL be recorded with class `ledger-ahead`

#### Scenario: A missing external object is classed external-absent

- **WHEN** the ledger records `pr_opened` but the verified identity reports no PR exists on the head
- **THEN** a drift entry SHALL be recorded with class `external-absent`

#### Scenario: An aligned item produces no drift

- **WHEN** the ledger state and the verified identity agree
- **THEN** no drift entry SHALL be recorded for that item

### Requirement: Reconciliation SHALL repair only benign forward drift and surface contradictions

Reconciliation SHALL repair `ledger-behind` drift by applying the catch-up transition to the
externally verified state as an audited ledger update that appends a history entry and emits an
event. Reconciliation SHALL NOT rewrite the ledger for `ledger-ahead`, `external-absent`, or
`identity-mismatch` drift in either direction; it SHALL record the conflict and route the item to a
human. No repair path SHALL perform any external mutation — no merge, push, label write, PR edit,
release, or deploy.

#### Scenario: Benign catch-up drift is repaired forward

- **WHEN** an item's `ledger-behind` drift shows the PR verified as `merged`
- **THEN** reconciliation SHALL transition the item forward to `merged` with a history entry and an
  event
- **AND** no external mutation SHALL be recorded through the injected seam

#### Scenario: An over-claim is surfaced, never silently resolved

- **WHEN** an item has `ledger-ahead` drift (the ledger claims a remote state the identity does not
  support)
- **THEN** the item's ledger state SHALL NOT be changed in either direction
- **AND** the drift SHALL be recorded and the item routed to a human next action

#### Scenario: Repair never mutates the remote

- **WHEN** any repair path is exercised through the injected seam
- **THEN** no GitHub write, git push, label change, or PR edit SHALL be recorded

### Requirement: Caller-supplied state SHALL never prove a remote transition

The engine SHALL refuse, as a validation failure that leaves durable state unchanged, any transition
into a remote-proving state — `pr_opened`, `ready`, `merged`, `released`, or `deployed` — unless a
fresh engine-verified `LoopExternalIdentity` supporting that state is supplied. This guard SHALL compose
with, and never bypass, the engine's existing authority-gate and directly-verified-evidence
requirements. A transition into a local state such as `implemented` SHALL NOT require an external
identity.

#### Scenario: An unproven remote-proving transition is refused

- **WHEN** a transition into `merged` is requested with no verified identity reporting the PR merged
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: A proven remote-proving transition is accepted

- **WHEN** a transition into `merged` is requested and a fresh verified identity reports the PR
  `merged`
- **THEN** it SHALL be accepted subject to the existing authority and evidence gates

#### Scenario: A stale identity does not prove a transition

- **WHEN** a transition into `pr_opened` is requested and the only supplied identity was observed
  outside the freshness window
- **THEN** it SHALL be refused as a validation failure
- **AND** the item's state SHALL be unchanged

#### Scenario: A local transition needs no external identity

- **WHEN** a transition into `implemented` is requested with no external identity
- **THEN** the remote-proving guard SHALL NOT refuse it on identity grounds

### Requirement: Reconciliation SHALL compute a deterministic next action per active item

Reconciliation SHALL compute, from the reconciled item state and its verified external identity
alone, exactly one next action per active item drawn from the closed `LoopNextAction` set:
`advance`, `await-checks`, `repair-forward`, `clear-merge-barrier`, `hold-for-human`, or `noop`. The
computation SHALL be pure — no clock read, randomness, or I/O — so identical inputs always yield the
identical action.

#### Scenario: Pending checks yield await-checks

- **WHEN** an item is aligned at `pr_opened` and its verified `checks_conclusion` is `pending`
- **THEN** its computed next action SHALL be `await-checks`

#### Scenario: A contradiction yields hold-for-human

- **WHEN** an item has `ledger-ahead`, `external-absent`, or `identity-mismatch` drift
- **THEN** its computed next action SHALL be `hold-for-human`

#### Scenario: The computation is deterministic

- **WHEN** next-action computation runs twice on identical item state and identity inputs
- **THEN** it SHALL return the identical action both times

