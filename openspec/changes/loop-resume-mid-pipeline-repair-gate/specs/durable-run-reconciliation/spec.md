## ADDED Requirements

### Requirement: Reconciliation SHALL NOT repair-forward mid-flight local work to pr_opened on open PR alone

When an item's ledger state is a non-remote-proving local state — including `pending`, `in_progress`, and `implemented` — and the verified `LoopExternalIdentity` reports an open PR, reconciliation SHALL consult the identity's live `pipeline_stage`. If that stage is mid-flight advance work (active pipeline stages such as `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, planning stages, and any other non-terminal advance-loop stage that is neither pre-pipeline nor `ready-to-deploy`), reconciliation SHALL NOT classify the item as `ledger-behind` solely because the PR is open, and SHALL NOT repair the ledger state to `pr_opened`. The item's local ledger state SHALL remain unchanged by that open-PR observation so a subsequent supervisor cycle can still dispatch or re-dispatch it. Checks conclusion (including `success`) SHALL NOT override this gate. True terminal catch-up remains separate: a verified merged PR or ready-to-deploy label may still drive forward repair per the existing benign catch-up rules.

#### Scenario: in_progress plus open PR at fix-2 is not repaired to pr_opened

- **WHEN** the ledger records `in_progress` and the verified identity reports `pr_state` `open`, `checks_conclusion` `success`, and `pipeline_stage` `fix-2`
- **THEN** reconciliation SHALL NOT record `ledger-behind` drift for that open-PR observation alone
- **AND** the item's ledger state SHALL remain `in_progress`
- **AND** the item SHALL NOT be repaired to `pr_opened`

#### Scenario: pending plus open PR mid-pipeline is not stranded at pr_opened

- **WHEN** the ledger records `pending` and the verified identity reports an open PR with mid-flight `pipeline_stage` (e.g. `review-1`)
- **THEN** reconciliation SHALL NOT repair the item to `pr_opened`
- **AND** the item's ledger state SHALL remain `pending` so the scheduler can still admit it

#### Scenario: Green checks do not force pr_opened catch-up for mid-flight work

- **WHEN** the ledger records `in_progress` and the verified identity reports open PR, `checks_conclusion` `success`, and mid-flight `pipeline_stage` `pre-merge`
- **THEN** the item's computed next action SHALL NOT be the only residual path of non-consuming `advance` on state `pr_opened`
- **AND** the item SHALL remain in a local dispatchable state after the reconciliation pass

#### Scenario: Merged PR still repair-forwards from a local state

- **WHEN** the ledger records `in_progress` (or `implemented`) and the verified identity reports `pr_state` `merged`
- **THEN** reconciliation SHALL classify the drift as `ledger-behind`
- **AND** SHALL repair the item forward to `merged` with a history entry and event

#### Scenario: Ready-to-deploy label still repair-forwards from a local state

- **WHEN** the ledger records `in_progress` and the verified identity reports an open PR with `ready_label_present` true
- **THEN** reconciliation SHALL repair the item forward to `ready` as benign catch-up
- **AND** SHALL NOT leave the item at `pr_opened` when the ready-to-deploy label is verified present

### Requirement: Reconciliation SHALL treat open PR alone as insufficient remote proof to leave mid-flight work at pr_opened

Reconciliation's verified forward target for a local ledger state SHALL NOT select `pr_opened` when the verified `pipeline_stage` indicates mid-flight advance work still remains on the issue. Open PR presence remains necessary evidence for remote-proving states that truly apply, but mid-flight continuity is expressed by leaving the local ledger state (or by an explicit mid-flight restore), not by parking the item at `pr_opened` with a next action the supervisor does not consume. Unit tests SHALL cover pure `classifyDrift` / reconcile behavior for local + open PR + mid-flight stage and SHALL fail against the unguarded open-PR ⇒ `pr_opened` behavior.

#### Scenario: Pure classifyDrift refuses open-PR ledger-behind for mid-flight local state

- **WHEN** `classifyDrift` is invoked with ledger state `in_progress` and an identity whose PR is open and `pipeline_stage` is `fix-2`
- **THEN** it SHALL NOT return `ledger-behind` for that combination
- **AND** a regression asserting the pre-fix unguarded return of `ledger-behind` SHALL fail without the gate

#### Scenario: Reconcile pass leaves mid-flight item dispatchable among siblings

- **WHEN** a run ledger has item A `in_progress` with mid-flight open-PR identity and item B `pending` with no PR
- **AND** one reconciliation pass runs through the injected observation seam
- **THEN** item A SHALL remain dispatchable (state `in_progress`, not stranded `pr_opened`)
- **AND** item B remaining `pending` SHALL NOT be the sole reason A is never re-driven after the pass
