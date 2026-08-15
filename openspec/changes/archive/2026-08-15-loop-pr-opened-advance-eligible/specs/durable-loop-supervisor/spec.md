## ADDED Requirements

### Requirement: Supervisor SHALL re-dispatch advance-still-needed items restored to in_progress

When reconciliation restores an advance-still-needed item from stranded `pr_opened` to `in_progress` — including intake-ready stage `ready` with open PR and no ready-to-deploy label, and mid-flight open PR — the supervisor SHALL include that item among active `in_progress` re-dispatches and SHALL drive it through `pipeline/loop-execution@1` so advance continues toward `pipeline:ready-to-deploy`. The supervisor SHALL NOT leave such an item idle with `next_actions` equal to `advance` while only selecting unrelated `pending` siblings or recording `no_eligible_item`. Supervisor-level regression tests SHALL assert the execution seam call trace (`dispatchItem` / equivalent) and that `dispatched >= 1` for the fixture, not only final ledger state.

#### Scenario: Intake-ready pr_opened fixture dispatches advance

- **WHEN** the ledger records `pr_opened` for item N with verified open PR, checks `success`, `pipeline_stage` `ready`, and `ready_label_present` false
- **AND** a supervisor cycle runs after reconciliation under injected seams
- **THEN** reconciliation SHALL leave item N dispatchable as `in_progress` (or equivalent dispatchable local state)
- **AND** the execution call trace SHALL include a dispatch for item N through `pipeline/loop-execution@1`
- **AND** the cycle evidence SHALL show `dispatched >= 1` for that item path

#### Scenario: Healed advance-still-needed item is re-dispatched before pending sibling selection can strand it

- **WHEN** the ledger has item A advance-still-needed (restored or remaining `in_progress`) and item B `pending`
- **AND** a supervisor cycle runs after reconciliation under injected seams
- **THEN** the execution call trace SHALL include a dispatch for item A
- **AND** the cycle SHALL NOT leave A at non-dispatchable `pr_opened` and then only start B

### Requirement: Supervisor SHALL NOT stop supervisor_no_progress while next_actions is advance

The supervisor MUST NOT record run stop reason `supervisor_no_progress` when the latest reconciliation `next_actions` map still contains `advance` for any non-done contract item that remains advance-eligible (open PR or equivalent live work still needing advance toward ready-to-deploy). Consecutive `no_eligible_item` no-ops while `next_actions` advertises `advance` are a workflow-engine defect surface to repair via reconcile restore + re-dispatch, not a legitimate terminal for “nothing left to do.” The existing consecutive no-progress watchdog remains valid for genuine no-progress cases (holds, coexistence waits without durable progress, empty work with no `advance` next action).

#### Scenario: next_actions advance never terminates supervisor_no_progress

- **WHEN** a durable run's latest reconciliation reports `next_actions[N] === "advance"` for non-done item N
- **AND** consecutive cycle no-progress would otherwise reach the configured limit
- **THEN** the supervisor SHALL NOT stop the run with reason `supervisor_no_progress` solely because no pending item was scheduled
- **AND** the run SHALL instead re-dispatch N after restore or otherwise continue without that false terminal

#### Scenario: Genuine no-progress without advance next action still may stop

- **WHEN** no contract item has `next_actions` equal to `advance`
- **AND** no item is dispatchable and no durable progress is recorded for the consecutive no-progress limit
- **THEN** the existing `supervisor_no_progress` watchdog MAY still stop the run under prior policy

## MODIFIED Requirements

### Requirement: Supervisor SHALL NOT rely on non-consuming next_actions.advance for mid-flight continuity

The supervisor's executable work selection SHALL continue to admit new work from the `pending` frontier and re-drive existing `in_progress` items. For continuity after resume or after reconcile restore of advance-still-needed work (mid-flight **or** intake-ready / non-R2D open PR), the durable path SHALL be a dispatchable local ledger state (`in_progress` re-dispatch, or `pending` admission after start), not an unconsumed `next_actions` value of `advance` on ledger state `pr_opened`. If reconciliation restores a previously stranded `pr_opened` advance-still-needed item to `in_progress` (heal path), the supervisor SHALL re-dispatch that item on the subsequent cycle exactly as any other `in_progress` item. Re-dispatch SHALL use the item's fresh observed labels and continue from the live stage rather than restarting pipeline work from a pre-pipeline stage solely to re-enter advance. Intake-ready stage `ready` on an open PR that is not ready-to-deploy SHALL continue through review / pre-merge / ready-to-deploy stages via that re-dispatch; it SHALL NOT be treated as finished.

#### Scenario: Mid-flight continuity does not depend on dead advance action

- **WHEN** a mid-pipeline item is continuing after resume
- **THEN** its continuation SHALL occur because it is `in_progress` (re-dispatch) or becomes `in_progress` after a valid start from `pending`
- **AND** continuation SHALL NOT depend solely on `next_actions[item] === "advance"` while state is `pr_opened` with no consumer

#### Scenario: Healed pr_opened mid-flight item is re-dispatched

- **WHEN** reconciliation has restored a mid-flight item from stranded `pr_opened` to `in_progress` under the mid-flight / advance-still-needed heal path
- **THEN** the supervisor SHALL include that item among active `in_progress` re-dispatches in the cycle
- **AND** SHALL drive it through `pipeline/loop-execution@1` without a human external re-drive

#### Scenario: Healed pr_opened intake-ready item is re-dispatched

- **WHEN** reconciliation has restored an intake-ready item (`pipeline_stage` `ready`, open PR, not ready-to-deploy) from stranded `pr_opened` to `in_progress`
- **THEN** the supervisor SHALL include that item among active `in_progress` re-dispatches in the cycle
- **AND** SHALL drive it through `pipeline/loop-execution@1` so advance continues toward ready-to-deploy

#### Scenario: Re-dispatch continues from live stage labels

- **WHEN** an advance-still-needed `in_progress` item is re-dispatched after resume or heal
- **THEN** the dispatch SHALL go through the existing `pipeline/loop-execution@1` path that advances from current labels
- **AND** the supervisor SHALL NOT introduce a new transition that clears live progress solely to re-enter advance from scratch
