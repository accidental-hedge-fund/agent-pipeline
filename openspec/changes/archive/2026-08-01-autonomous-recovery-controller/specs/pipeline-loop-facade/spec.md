## MODIFIED Requirements

### Requirement: Per-item execution SHALL use the engine-neutral `pipeline/loop-execution@1` contract

The interface between the loop orchestrator and per-item Pipeline execution SHALL be a single
documented, versioned contract identified as `pipeline/loop-execution@1`, and it SHALL be identical
for every configured engine and harness. Its request SHALL carry `item_id`, `repo` (`name`,
`base_branch`), `engine`, `worktree_policy`, `done_definition`, and `run_id`. Its dispatch outcome
SHALL be exactly one of `ready_to_deploy`, `blocked_recoverable`, `blocked_needs_human`,
`capacity_wait`, `coexistence_wait`, `failed`, or `abandoned`. Every blocked outcome SHALL carry the
canonical `pipeline/stage-diagnostic@1`; a missing, malformed, or disposition-inconsistent
diagnostic SHALL become `failed` as a protocol defect. Every response SHALL return an evidence
pointer containing the PR number when one exists plus the Pipeline run identifier. The contract
SHALL NOT expose any per-stage verb, so the orchestrator hands off a whole item and the per-item
advance loop never owns more than one issue.

#### Scenario: An item hand-off carries the full request

- **WHEN** the orchestrator dispatches a selected item for execution
- **THEN** the request SHALL include `item_id`, `repo.name`, `repo.base_branch`, `engine`,
  `worktree_policy`, `done_definition`, and `run_id`

#### Scenario: An unrecognized outcome is not silently retried

- **WHEN** per-item execution reports an outcome outside the defined dispatch-outcome set
- **THEN** the orchestrator SHALL record a typed protocol failure
- **AND** it SHALL NOT treat the response as success or silently re-dispatch the item

#### Scenario: A recoverable block carries canonical diagnostics

- **WHEN** per-item execution reports `blocked_recoverable`
- **THEN** the response SHALL carry a valid diagnostic whose projection is `recover`
- **AND** the orchestrator SHALL route that diagnostic through bounded recovery

#### Scenario: A needs-human outcome requires human-decision diagnostic

- **WHEN** per-item execution reports `blocked_needs_human`
- **THEN** the response SHALL carry a valid `human-decision-required` diagnostic
- **AND** the outcome name or issue labels alone SHALL not establish human authority

#### Scenario: The interface exposes no per-stage verb

- **WHEN** the `pipeline/loop-execution@1` contract is inspected
- **THEN** it SHALL contain no operation that advances a single pipeline stage
- **AND** the contract SHALL be byte-identical in meaning for every configured engine and harness

### Requirement: Selected items SHALL execute through the unmodified Pipeline state machine and evidence gates

Every item selected by a loop run, including an item re-entered after mechanical recovery, SHALL be
executed through the normal Agent Pipeline state machine, review layer, and evidence gates. The
facade SHALL NOT set, skip, or reorder pipeline stage labels itself, SHALL NOT weaken or bypass
review, eval, OpenSpec, CI, or pre-merge gates, and SHALL treat an item as done only at
`pipeline:ready-to-deploy`. The facade SHALL NOT merge and SHALL NOT weaken the durable loop
engine's authority, release, dependency, recovery, or reconciliation gates. A blocked dispatch
SHALL remain not-done and SHALL carry its typed diagnostic into the controller; only a current
canonical `human-decision-required` diagnostic SHALL route it to a human hold.

#### Scenario: The facade does not move stage labels

- **WHEN** a loop run executes or repairs an item
- **THEN** all pipeline stage-label transitions SHALL originate from the Pipeline state machine
- **AND** the facade SHALL issue no stage-label write of its own

#### Scenario: Done means ready-to-deploy

- **WHEN** an item's execution reports `ready_to_deploy`
- **THEN** the ledger SHALL record it as done at `pipeline:ready-to-deploy`
- **AND** no merge SHALL be performed by the loop or the facade

#### Scenario: A blocked item does not advance the run past its gates

- **WHEN** an item's execution reports `blocked_recoverable` or `blocked_needs_human`
- **THEN** the run SHALL preserve the typed diagnostic and honor recovery, authority, and
  reconciliation semantics
- **AND** the item SHALL NOT be recorded as done

#### Scenario: Recovered item re-runs every applicable gate

- **WHEN** a recovery action creates a candidate-changing commit and the same item is redispatched
- **THEN** the next normal dispatch SHALL re-run the applicable review and deterministic gates
- **AND** prior evidence SHALL NOT be reused as approval for the changed candidate

#### Scenario: Single-issue and multi-item facades are behaviorally identical

- **WHEN** the same issue and diagnostic are dispatched through a one-item drive and a multi-item drive
- **THEN** both SHALL use the same `pipeline/loop-execution@1` whole-item request and response contract
- **AND** neither host facade SHALL add provider-specific recovery or human-authority policy
