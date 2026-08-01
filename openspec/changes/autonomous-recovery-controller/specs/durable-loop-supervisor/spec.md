## MODIFIED Requirements

### Requirement: The supervisor SHALL drive a compiled run to a terminal condition through the durable engine

The durable loop supervisor SHALL be an Agent Pipeline-owned in-repo runtime that, given an
already-compiled and locked run, advances that run by repeating a bounded cycle: reconcile live
truth, reconcile any `started` recovery attempt, select the next dependency-ready active
item honoring the contract's active-item limit, dispatch that whole item, reconcile the dispatch
outcome against fresh live truth, execute any safe claimed recovery action before terminal
classification, and record the resulting resume, wait, hold, completion, or stop through the
durable engine. The supervisor SHALL continue until every item is done or abandoned, a genuine
current human-authority hold leaves no sibling able to progress, or an engine-owned terminal stop
is recorded after bounded recovery is exhausted. The supervisor SHALL NOT invoke or depend on an
external goal-loop skill and SHALL NOT create a second ledger, lock, run-id namespace, or run
directory.

#### Scenario: A locked run advances to completion in-repo

- **WHEN** the supervisor is attached to a compiled, locked run whose items are executable or
  mechanically recoverable
- **THEN** it SHALL execute and recover items in dependency order until a genuine terminal
  condition
- **AND** no subprocess invocation of an external goal-loop skill or state CLI SHALL occur

#### Scenario: The run halts only after terminal reconciliation

- **WHEN** a cycle appears to reach completion, a human hold, or an engine-owned stop
- **THEN** the supervisor SHALL reconcile fresh live truth and outstanding recovery claims before
  halting
- **AND** it SHALL not halt while a safe due recovery or schedulable sibling remains

#### Scenario: A hold or recoverable block alongside a schedulable item does not halt the run

- **WHEN** one item has a current human hold or engine-owned recoverable block while another item is
  schedulable
- **THEN** the supervisor SHALL exclude the held or blocked item from the current frontier and
  continue the schedulable item
- **AND** it SHALL preserve the held or blocked item's durable state and attempt history

#### Scenario: Only the configured active-item limit is dispatched

- **WHEN** the supervisor selects work for a cycle
- **THEN** it SHALL dispatch no more than the contract's active-item limit
- **AND** it SHALL respect dependency ordering when choosing work

### Requirement: The supervisor SHALL hand off whole items and never own a pipeline stage

The supervisor SHALL dispatch selected work only through the provider-neutral
`pipeline/loop-execution@1` whole-item contract and SHALL treat only `ready_to_deploy`,
`blocked_recoverable`, `blocked_needs_human`, `capacity_wait`, `coexistence_wait`, `failed`, and
`abandoned` as dispatch outcomes. It SHALL NOT set, skip, or reorder a pipeline stage label, call a
per-stage verb, select a model or effort, or branch on a harness/provider name. It SHALL NOT merge,
release, deploy, enter credentials, or create an override. An item is done only at
`pipeline:ready-to-deploy`. An outcome outside the contract SHALL become a typed protocol defect
and enter bounded engine recovery rather than being silently re-dispatched or treated as human
authority.

#### Scenario: Stage transitions originate in the advance state machine

- **WHEN** the supervisor drives a normal or repair dispatch
- **THEN** every pipeline stage-label transition SHALL originate in the per-item Pipeline state
  machine
- **AND** the supervisor SHALL issue no stage-label write and no merge of its own

#### Scenario: Done means ready-to-deploy, not merged

- **WHEN** an item's execution reports `ready_to_deploy`
- **THEN** the ledger SHALL record it as done at `pipeline:ready-to-deploy`
- **AND** the supervisor SHALL perform no merge

#### Scenario: Recovery execution remains provider-neutral

- **WHEN** a `blocked_recoverable` dispatch is eligible for `repair_pipeline_item`
- **THEN** the supervisor SHALL pass the diagnostic and attempt identity to the registered recovery
  executor
- **AND** it SHALL not inspect or select the configured implementer harness, model, or effort

#### Scenario: An unrecognized outcome is a typed protocol defect

- **WHEN** per-item execution reports an outcome outside the contract
- **THEN** the supervisor SHALL record a typed protocol `workflow-engine-defect`
- **AND** it SHALL not treat the response as success, human authority, or an unbounded retry

## ADDED Requirements

### Requirement: The supervisor SHALL execute recovery before hold or stop classification

After every blocked or failed dispatch, the supervisor SHALL reconcile the item's current live
identity and diagnostic, project its recovery disposition, and consult the durable attempt ledger
before recording a hold or stop. For an engine-owned recoverable disposition, it SHALL claim and
charge a permitted recipe before side effects, execute it, and reconcile its result. Only a
current canonical `human-decision-required` diagnostic SHALL permit an immediate human hold.
Only exhausted or unrecoverable engine-owned work SHALL permit a terminal system stop.

#### Scenario: Failed dispatch recovers before run-fatal

- **WHEN** a dispatch returns an engine-owned diagnostic with safe recipe budget remaining
- **THEN** the supervisor SHALL execute the recovery flow before persisting `run_fatal`
- **AND** success SHALL re-enter the same item through normal whole-item execution

#### Scenario: Failed recovery remains charged and bounded

- **WHEN** a claimed recovery action fails
- **THEN** the supervisor SHALL persist the failed result against the charged claim
- **AND** it SHALL retry only while the keyed policy budget permits

#### Scenario: Blocked label alone does not create a hold

- **WHEN** fresh live truth contains `pipeline:blocked` but dispatch evidence has no current valid
  `human-decision-required` diagnostic
- **THEN** the supervisor SHALL NOT create a human hold from the label alone
- **AND** it SHALL classify the diagnostic as engine-owned recovery or terminal system failure

### Requirement: Every terminal driver exit SHALL emit one durable terminal event

Before the supervisor process exits with a terminal run result, it SHALL persist exactly one
terminal event kind for that exit. Existing stop transitions SHALL continue to append
`loop_run_stopped`; resolved and genuine-human-hold exits SHALL append `loop_run_complete` with
their final item accounting. A process interruption while recovery remains possible SHALL NOT emit
a terminal event. Re-entry SHALL not duplicate an already persisted terminal event for the same
terminal revision.

#### Scenario: Completed run emits completion event

- **WHEN** every item reconciles to done or abandoned and the driver exits successfully
- **THEN** exactly one durable `loop_run_complete` event SHALL be appended before exit
- **AND** it SHALL carry the final item accounting

#### Scenario: Exhausted run emits stop event

- **WHEN** engine-owned recovery is exhausted, no sibling can progress, and the run terminalizes
- **THEN** exactly one durable `loop_run_stopped` event SHALL be appended before exit
- **AND** the event SHALL distinguish exhausted engine failure from human authority

#### Scenario: Interrupted recoverable run is not terminal

- **WHEN** the supervisor process is interrupted while an item remains recoverable
- **THEN** the supervisor SHALL NOT emit a terminal completion or stop event
- **AND** the run SHALL remain resumable
