## ADDED Requirements

### Requirement: Reconciliation SHALL classify mid-flight pipeline stages from the authoritative stage vocabulary

Reconciliation SHALL determine whether a verified `LoopExternalIdentity.pipeline_stage` is mid-flight advance work using a pure predicate derived from the pipeline's authoritative `STAGES` vocabulary (`core/scripts/types.ts`). Mid-flight stages SHALL be the active advance-loop stages: `planning`, `plan-review`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, and `shipcheck-gate`. The following SHALL NOT be mid-flight: missing stage (`null`), `backlog`, `ready`, `ready-to-deploy`, and `needs-human`. An unknown non-null stage string that is not a member of `STAGES` SHALL be treated as mid-flight so future vocabulary growth does not reintroduce stranding. Unit tests SHALL lock this membership table.

#### Scenario: Known advance stages are mid-flight

- **WHEN** `pipeline_stage` is `fix-2`, `review-1`, `pre-merge`, `implementing`, `planning`, `design-gate`, or `visual-gate`
- **THEN** the mid-flight predicate SHALL return true

#### Scenario: Missing and terminal stages are not mid-flight

- **WHEN** `pipeline_stage` is `null`, `backlog`, `ready`, `ready-to-deploy`, or `needs-human`
- **THEN** the mid-flight predicate SHALL return false

#### Scenario: Unknown non-null stage is treated as mid-flight

- **WHEN** `pipeline_stage` is a non-null string that is not a member of `STAGES`
- **THEN** the mid-flight predicate SHALL return true

### Requirement: Reconciliation SHALL NOT repair-forward mid-flight local work to pr_opened on open PR alone

When an item's ledger state is a non-remote-proving local state — including `pending`, `in_progress`, and `implemented` — and the verified `LoopExternalIdentity` reports an open PR, reconciliation SHALL consult the identity's live `pipeline_stage` via the mid-flight predicate. If that stage is mid-flight, reconciliation SHALL NOT classify the item as `ledger-behind` solely because the PR is open, and SHALL NOT repair the ledger state to `pr_opened`. The item's local ledger state SHALL remain unchanged by that open-PR observation so a subsequent supervisor cycle can still dispatch or re-dispatch it. Checks conclusion (`success`, `failure`, `pending`, or absent) SHALL NOT override this gate. True terminal catch-up remains separate and takes precedence: a verified merged PR or ready-to-deploy label may still drive forward repair per the existing benign catch-up rules even when the stage string would otherwise be mid-flight.

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

#### Scenario: Failing or pending checks do not bypass the mid-flight gate

- **WHEN** the ledger records `in_progress` and the verified identity reports open PR with mid-flight `pipeline_stage` and `checks_conclusion` is `failure` or `pending`
- **THEN** reconciliation SHALL NOT repair the item to `pr_opened`
- **AND** the item's ledger state SHALL remain `in_progress`

#### Scenario: Merged PR still repair-forwards from a local state

- **WHEN** the ledger records `in_progress` (or `implemented`) and the verified identity reports `pr_state` `merged`
- **THEN** reconciliation SHALL classify the drift as `ledger-behind`
- **AND** SHALL repair the item forward to `merged` with a history entry and event
- **AND** mid-flight stage SHALL NOT block this catch-up

#### Scenario: Ready-to-deploy label still repair-forwards from a local state

- **WHEN** the ledger records `in_progress` and the verified identity reports an open PR with `ready_label_present` true
- **THEN** reconciliation SHALL repair the item forward to `ready` as benign catch-up
- **AND** SHALL NOT leave the item at `pr_opened` when the ready-to-deploy label is verified present
- **AND** mid-flight stage SHALL NOT block this catch-up

### Requirement: Reconciliation SHALL preserve open-PR catch-up to pr_opened when stage is not mid-flight

When an item's ledger state is a local non-remote-proving state and the verified identity reports an open PR without `ready_label_present` and without a merged PR, and `pipeline_stage` is not mid-flight (including missing/`null` stage), reconciliation SHALL continue to classify open-PR catch-up as `ledger-behind` and MAY repair-forward to `pr_opened`. This preserves the #511 crash-after-PR-open recovery path for cases where live labels do not indicate ongoing mid-pipeline advance work.

#### Scenario: Local state plus open PR with null stage still repairs to pr_opened

- **WHEN** the ledger records `implemented` (or `in_progress`) and the verified identity reports an open PR with `pipeline_stage` `null`
- **THEN** reconciliation SHALL classify the drift as `ledger-behind`
- **AND** SHALL repair the item forward to `pr_opened`

#### Scenario: Local state plus open PR at ready stage still repairs to pr_opened

- **WHEN** the ledger records a local state and the verified identity reports an open PR with `pipeline_stage` `ready` and `ready_label_present` false
- **THEN** reconciliation SHALL repair-forward to `pr_opened` (or otherwise treat open PR as verified forward catch-up to `pr_opened`)
- **AND** SHALL NOT apply the mid-flight gate

### Requirement: Reconciliation SHALL heal stranded pr_opened mid-flight items back to in_progress

When the ledger state is already `pr_opened` (including rows stranded by pre-fix over-repair) and the verified identity reports an open PR with mid-flight `pipeline_stage`, and neither merged-PR nor ready-to-deploy catch-up applies, reconciliation SHALL restore the item to `in_progress` via an audited ledger history entry (and event) so the supervisor can re-dispatch it. The heal SHALL apply regardless of non-forward identity drift on the stranded row — including `identity-mismatch` from a changed PR head SHA or PR number, and `checks-regressed` — because pre-fix stranded rows normally retain `last_verified_identity` and ordinary mid-flight commit or check churn MUST NOT leave the item permanently non-dispatchable. Observed non-forward drift SHALL still be recorded on the reconciliation result, and the heal SHALL update `last_verified_identity` to the freshly observed identity. The heal SHALL be idempotent: a subsequent reconcile with the same mid-flight open-PR identity SHALL leave the item at `in_progress` without oscillating back to `pr_opened`. The heal SHALL NOT apply when `pipeline_stage` is not mid-flight, when the PR is merged, or when `ready_label_present` is true.

#### Scenario: Stranded pr_opened at fix-2 heals to in_progress

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, mid-flight `pipeline_stage` `fix-2`, and no ready-to-deploy label
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** SHALL append a history note that records the mid-flight restore
- **AND** the item SHALL NOT remain stranded at `pr_opened` with only non-consuming `advance`

#### Scenario: Heal applies despite stale last_verified_identity head SHA

- **WHEN** the ledger records `pr_opened` with a prior `last_verified_identity` whose `head_sha` differs from the freshly observed open-PR identity
- **AND** the observed identity reports mid-flight `pipeline_stage` and no ready-to-deploy label
- **AND** `classifyDrift` would return a non-forward class such as `identity-mismatch`
- **THEN** reconciliation SHALL still restore the item to `in_progress`
- **AND** SHALL update `last_verified_identity` to the observed identity
- **AND** SHALL still record the observed non-forward drift on the reconciliation result

#### Scenario: Heal is idempotent across repeated resumes

- **WHEN** a mid-flight item has been healed from `pr_opened` to `in_progress`
- **AND** reconciliation runs again with the same open PR and mid-flight stage
- **THEN** the item's state SHALL remain `in_progress`
- **AND** reconciliation SHALL NOT re-promote the item to `pr_opened`

#### Scenario: Heal does not override ready or merged catch-up

- **WHEN** the ledger records `pr_opened` and the verified identity reports `pr_state` `merged` or `ready_label_present` true
- **THEN** reconciliation SHALL repair-forward to `merged` or `ready` respectively
- **AND** SHALL NOT heal to `in_progress`

### Requirement: Reconciliation SHALL treat open PR alone as insufficient remote proof to leave mid-flight work at pr_opened

Reconciliation's verified forward target for a local ledger state SHALL NOT select `pr_opened` when the verified `pipeline_stage` indicates mid-flight advance work still remains on the issue. Open PR presence remains necessary evidence for remote-proving states that truly apply, but mid-flight continuity is expressed by leaving the local ledger state or by the explicit mid-flight restore heal, not by parking the item at `pr_opened` with a next action the supervisor does not consume. Unit tests SHALL cover pure `classifyDrift` / reconcile behavior for local + open PR + mid-flight stage and SHALL fail against the unguarded open-PR ⇒ `pr_opened` behavior.

#### Scenario: Pure classifyDrift refuses open-PR ledger-behind for mid-flight local state

- **WHEN** `classifyDrift` is invoked with ledger state `in_progress` and an identity whose PR is open and `pipeline_stage` is `fix-2`
- **THEN** it SHALL NOT return `ledger-behind` for that combination
- **AND** a regression asserting the pre-fix unguarded return of `ledger-behind` SHALL fail without the gate

#### Scenario: Reconcile pass leaves mid-flight item dispatchable among siblings

- **WHEN** a run ledger has item A `in_progress` with mid-flight open-PR identity and item B `pending` with no PR
- **AND** one reconciliation pass runs through the injected observation seam
- **THEN** item A SHALL remain dispatchable (state `in_progress`, not stranded `pr_opened`)
- **AND** item B remaining `pending` SHALL NOT be the sole reason A is never re-driven after the pass
