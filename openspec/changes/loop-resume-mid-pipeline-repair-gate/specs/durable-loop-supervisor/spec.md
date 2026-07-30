## ADDED Requirements

### Requirement: Supervisor resume SHALL re-drive mid-pipeline items that remain in_progress after reconciliation

After `--resume <run-id>` attaches (including dead-holder lock recovery on the same host), the supervisor SHALL run reconciliation and then continue cycling. When reconciliation leaves an item in `in_progress` because live GitHub still shows mid-flight `pipeline:*` work (open PR or not), the supervisor SHALL re-dispatch that item through `pipeline/loop-execution@1` so advance continues from the issue's current stage labels. The supervisor SHALL NOT skip such an item solely because an open PR with green checks exists, and SHALL NOT prefer an unrelated `pending` sibling while a mid-pipeline `in_progress` item is still active and eligible for re-dispatch.

#### Scenario: Resume re-dispatches in_progress mid-flight item after crash

- **WHEN** a run is resumed after a mid-item crash with ledger state `in_progress` for item N and live labels still mid-pipeline (e.g. `pipeline:fix-2`)
- **AND** reconciliation does not demote item N to stranded `pr_opened`
- **THEN** the supervisor cycle SHALL re-dispatch item N through `pipeline/loop-execution@1`
- **AND** it SHALL NOT leave item N idle while only selecting a different `pending` sibling

#### Scenario: Open PR with green checks does not strand an active mid-pipeline item

- **WHEN** the active cycle's reconciliation observes item N as mid-flight with an open PR and checks `success` while ledger state remains `in_progress`
- **THEN** the supervisor SHALL treat item N as still active work and re-dispatch it
- **AND** SHALL NOT require a human `/pipeline N` outside the loop solely to continue that item

### Requirement: Supervisor SHALL NOT rely on non-consuming next_actions.advance for mid-flight continuity

The supervisor's executable work selection SHALL continue to admit new work from the `pending` frontier and re-drive existing `in_progress` items. For mid-flight continuity after resume, the durable path SHALL be a dispatchable local ledger state (`in_progress` re-dispatch, or `pending` admission after start), not an unconsumed `next_actions` value of `advance` on ledger state `pr_opened`. If reconciliation restores a previously stranded `pr_opened` mid-flight item to `in_progress` (heal path), the supervisor SHALL re-dispatch that item on the subsequent cycle exactly as any other `in_progress` item.

#### Scenario: Mid-flight continuity does not depend on dead advance action

- **WHEN** a mid-pipeline item is continuing after resume
- **THEN** its continuation SHALL occur because it is `in_progress` (re-dispatch) or becomes `in_progress` after a valid start from `pending`
- **AND** continuation SHALL NOT depend solely on `next_actions[item] === "advance"` while state is `pr_opened` with no consumer

#### Scenario: Healed pr_opened mid-flight item is re-dispatched

- **WHEN** reconciliation has restored a mid-flight item from stranded `pr_opened` to `in_progress` under the mid-flight repair gate / heal path
- **THEN** the supervisor SHALL include that item among active `in_progress` re-dispatches in the cycle
- **AND** SHALL drive it through `pipeline/loop-execution@1` without a human external re-drive
