## ADDED Requirements

### Requirement: Reconciliation SHALL treat not-R2D open PR at pr_opened as advance-still-needed work

Reconciliation SHALL treat a ledger item at `pr_opened` whose verified identity reports an open PR without `ready_label_present` (ready-to-deploy) and without a merged PR, and whose `pipeline_stage` is not the terminal off-ramp `needs-human`, as **advance-still-needed**. Intake-ready stage `ready` (`pipeline:ready`) is advance-still-needed, not finished. `ready_label_present` remains the sole identity flag for ready-to-deploy and MUST NOT be true solely because the issue carries intake-ready `pipeline:ready`. Mid-flight stages remain advance-still-needed (existing mid-flight heal is a subset of this class).

#### Scenario: Intake-ready open PR is advance-still-needed

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, `pipeline_stage` `ready`, `ready_label_present` false, and checks `success`
- **THEN** reconciliation SHALL classify the item as advance-still-needed
- **AND** SHALL NOT treat intake-ready alone as terminal completion

#### Scenario: Ready-to-deploy is not advance-still-needed

- **WHEN** the verified identity reports open PR and `ready_label_present` true
- **THEN** reconciliation SHALL NOT classify the item as advance-still-needed
- **AND** SHALL apply ready catch-up to ledger `ready` per existing terminal rules

#### Scenario: needs-human is not advance-still-needed heal fodder

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR with `pipeline_stage` `needs-human` and `ready_label_present` false
- **THEN** reconciliation SHALL NOT restore the item to `in_progress` solely under the advance-still-needed heal

### Requirement: Reconciliation SHALL restore advance-still-needed pr_opened items to in_progress

When the ledger state is `pr_opened` or non-dispatchable local `implemented` and the item is advance-still-needed (open PR, not `ready_label_present`, not merged, stage not `needs-human`), reconciliation SHALL restore the item to `in_progress` via an audited ledger history entry (and event) so the supervisor can re-dispatch advance through the normal `in_progress` path. The restore SHALL apply for intake-ready stage `ready`, for mid-flight stages, and for non-mid-flight stages that are still advance-still-needed (including missing/`null` stage when open PR remains and R2D is absent). The restore SHALL apply regardless of non-forward identity drift on the stranded row (`identity-mismatch`, `checks-regressed`), SHALL update `last_verified_identity` to the freshly observed identity, and SHALL be idempotent (second pass leaves `in_progress` without oscillating back to stranded `pr_opened` or non-dispatchable `implemented`). Merged PR and `ready_label_present` catch-up SHALL take precedence over this restore. Schedule-admissible `pending` is not restored by this heal.

#### Scenario: Stranded pr_opened at intake-ready heals to in_progress

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, `pipeline_stage` `ready`, `ready_label_present` false, and checks `success`
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** SHALL append a history note that records the advance-still-needed restore
- **AND** the item SHALL NOT remain stranded at `pr_opened` with only non-consuming `next_actions.advance`

#### Scenario: Mid-flight pr_opened heal remains

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, mid-flight `pipeline_stage` `fix-2`, and no ready-to-deploy label
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** the item SHALL NOT remain stranded at `pr_opened`

#### Scenario: Crash-after-PR-open implemented heals to in_progress

- **WHEN** the ledger records `implemented` and the verified identity reports open PR, not `ready_label_present`, not merged, and stage is not `needs-human`
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** SHALL append a history note that records the advance-still-needed restore
- **AND** the item SHALL NOT remain at non-dispatchable `implemented` outside every supervisor frontier

#### Scenario: Advance-still-needed heal is idempotent

- **WHEN** an advance-still-needed item has been restored from `pr_opened` or `implemented` to `in_progress`
- **AND** reconciliation runs again with the same open PR and still not ready-to-deploy
- **THEN** the item's state SHALL remain `in_progress`
- **AND** reconciliation SHALL NOT re-promote the item to stranded `pr_opened` or non-dispatchable `implemented`

#### Scenario: Heal does not override ready or merged catch-up

- **WHEN** the ledger records `pr_opened` and the verified identity reports `pr_state` `merged` or `ready_label_present` true
- **THEN** reconciliation SHALL repair-forward to `merged` or `ready` respectively
- **AND** SHALL NOT heal to `in_progress`

### Requirement: Reconciliation SHALL NOT repair-forward advance-still-needed local work to stranded pr_opened on open PR alone

When an item's ledger state is a non-remote-proving local state — including `pending`, `in_progress`, and `implemented` — and the verified identity reports an open PR without `ready_label_present` and without a merged PR, and the item is advance-still-needed (stage is not the terminal off-ramp that ends advance eligibility under the advance-still-needed definition, including intake-ready `ready` and mid-flight stages), reconciliation SHALL NOT classify open-PR alone as `ledger-behind` solely to park the item at stranded `pr_opened`, and SHALL NOT repair the ledger state to `pr_opened` when that would leave only non-consuming `next_actions.advance`. Supervisor-dispatchable local states (`in_progress`, schedule-admissible `pending`) SHALL remain on that path. Non-dispatchable local `implemented` that is advance-still-needed SHALL be restored to `in_progress` (same heal as stranded `pr_opened`) so a subsequent supervisor cycle can re-dispatch it. True terminal catch-up remains separate and takes precedence: a verified merged PR or ready-to-deploy label may still drive forward repair. This requirement generalizes the mid-flight open-PR gate so intake-ready open PR cannot re-strand a just-healed `in_progress` item.

#### Scenario: in_progress plus open PR at intake-ready is not repaired to stranded pr_opened

- **WHEN** the ledger records `in_progress` and the verified identity reports `pr_state` `open`, `checks_conclusion` `success`, `pipeline_stage` `ready`, and `ready_label_present` false
- **THEN** reconciliation SHALL NOT record `ledger-behind` drift for that open-PR observation alone
- **AND** the item's ledger state SHALL remain `in_progress`
- **AND** the item SHALL NOT be repaired to stranded `pr_opened`

#### Scenario: Healed intake-ready item does not oscillate back to pr_opened

- **WHEN** reconciliation has restored an intake-ready item from `pr_opened` to `in_progress`
- **AND** a second reconciliation runs with the same open PR, stage `ready`, and `ready_label_present` false
- **THEN** the item SHALL remain `in_progress`
- **AND** reconciliation SHALL NOT re-promote it to `pr_opened`

#### Scenario: Merged and ready-to-deploy still catch up from local state

- **WHEN** the ledger records `in_progress` and the verified identity reports `pr_state` `merged` or open PR with `ready_label_present` true
- **THEN** reconciliation SHALL repair-forward to `merged` or `ready` respectively
- **AND** the advance-still-needed local gate SHALL NOT block that terminal catch-up

## MODIFIED Requirements

### Requirement: Reconciliation SHALL heal stranded pr_opened mid-flight items back to in_progress

When the ledger state is already `pr_opened` (including rows stranded by pre-fix over-repair or by non-mid-flight open-PR catch-up) and the verified identity reports an open PR, and neither merged-PR nor ready-to-deploy catch-up applies, and the item is advance-still-needed (including mid-flight stages and intake-ready stage `ready`, and excluding terminal off-ramp `needs-human`), reconciliation SHALL restore the item to `in_progress` via an audited ledger history entry (and event) so the supervisor can re-dispatch it. The heal SHALL apply regardless of non-forward identity drift on the stranded row — including `identity-mismatch` from a changed PR head SHA or PR number, and `checks-regressed` — because stranded rows normally retain `last_verified_identity` and ordinary commit or check churn MUST NOT leave the item permanently non-dispatchable. Observed non-forward drift SHALL still be recorded on the reconciliation result, and the heal SHALL update `last_verified_identity` to the freshly observed identity. The heal SHALL be idempotent: a subsequent reconcile with the same advance-still-needed open-PR identity SHALL leave the item at `in_progress` without oscillating back to `pr_opened`. The heal SHALL NOT apply when the PR is merged, when `ready_label_present` is true, or when `pipeline_stage` is `needs-human`.

#### Scenario: Stranded pr_opened at fix-2 heals to in_progress

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, mid-flight `pipeline_stage` `fix-2`, and no ready-to-deploy label
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** SHALL append a history note that records the mid-flight restore
- **AND** the item SHALL NOT remain stranded at `pr_opened` with only non-consuming `advance`

#### Scenario: Stranded pr_opened at intake-ready heals to in_progress

- **WHEN** the ledger records `pr_opened` and the verified identity reports open PR, `pipeline_stage` `ready`, `ready_label_present` false, and checks `success`
- **THEN** reconciliation SHALL restore the item to `in_progress`
- **AND** the item SHALL NOT remain stranded at `pr_opened` with only non-consuming `advance`

#### Scenario: Heal applies despite stale last_verified_identity head SHA

- **WHEN** the ledger records `pr_opened` with a prior `last_verified_identity` whose `head_sha` differs from the freshly observed open-PR identity
- **AND** the observed identity reports advance-still-needed open PR (mid-flight or intake-ready) and no ready-to-deploy label
- **AND** `classifyDrift` would return a non-forward class such as `identity-mismatch`
- **THEN** reconciliation SHALL still restore the item to `in_progress`
- **AND** SHALL update `last_verified_identity` to the observed identity
- **AND** SHALL still record the observed non-forward drift on the reconciliation result

#### Scenario: Heal is idempotent across repeated resumes

- **WHEN** an advance-still-needed item has been healed from `pr_opened` to `in_progress`
- **AND** reconciliation runs again with the same open PR and still-not-R2D stage
- **THEN** the item's state SHALL remain `in_progress`
- **AND** reconciliation SHALL NOT re-promote the item to `pr_opened`

#### Scenario: Heal does not override ready or merged catch-up

- **WHEN** the ledger records `pr_opened` and the verified identity reports `pr_state` `merged` or `ready_label_present` true
- **THEN** reconciliation SHALL repair-forward to `merged` or `ready` respectively
- **AND** SHALL NOT heal to `in_progress`

### Requirement: Reconciliation SHALL preserve open-PR catch-up to pr_opened when stage is not mid-flight

When an item's ledger state is a local non-remote-proving state and the verified identity reports an open PR without `ready_label_present` and without a merged PR, and `pipeline_stage` is not mid-flight (including missing/`null` stage), reconciliation MAY still observe open-PR evidence for remote-proving bookkeeping, but SHALL NOT leave the item permanently stranded at `pr_opened` with only non-consuming `next_actions.advance` when the item remains advance-still-needed. Prefer: do not repair-forward local dispatchable states to stranded `pr_opened` solely because an open PR exists while advance still needed (see the advance-still-needed local gate). True terminal catch-up (merged / ready-to-deploy) is unchanged. Crash-after-PR-open recovery is expressed by making the item dispatchable for continued advance toward ready-to-deploy, not by parking it at non-consuming `pr_opened`. If a transitional repair to `pr_opened` still occurs, a subsequent (or same-pass) advance-still-needed restore MUST leave the item dispatchable as `in_progress`.

#### Scenario: Local state plus open PR with null stage still repairs to pr_opened

- **WHEN** the ledger records `implemented` (or `in_progress`) and the verified identity reports an open PR with `pipeline_stage` `null` and `ready_label_present` false
- **THEN** reconciliation SHALL NOT leave the item only at stranded `pr_opened` with non-consuming `advance` after the pass(es) required for restore
- **AND** the item SHALL be on a path the supervisor can dispatch (`in_progress` re-dispatch path — restore from `implemented` or transitional `pr_opened` to `in_progress`; `in_progress` may remain)

#### Scenario: Local state plus open PR at ready stage still repairs to pr_opened

- **WHEN** the ledger records a local state and the verified identity reports an open PR with `pipeline_stage` `ready` and `ready_label_present` false
- **THEN** reconciliation SHALL NOT leave the item stranded at `pr_opened` or non-dispatchable `implemented` with only non-consuming `advance` after restore
- **AND** SHALL NOT treat intake-ready as terminal completion
- **AND** SHALL NOT apply the mid-flight-only gate as the sole reason the item remains undriven
