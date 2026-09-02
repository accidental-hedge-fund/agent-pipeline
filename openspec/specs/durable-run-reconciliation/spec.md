# durable-run-reconciliation Specification

## Purpose
TBD - created by archiving change durable-run-reconciliation. Update Purpose after archive.

## Requirements

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

### Requirement: Blocked recovery SHALL outrank bare open-PR discovery
When the ledger records an item as `blocked`, a verified open PR alone SHALL NOT constitute
`ledger-behind` drift and SHALL NOT repair the item to `pr_opened`, regardless of the live pipeline
stage label. Reconciliation SHALL preserve the blocked state, its class, evidence, remaining budget,
and any `started` recovery attempt. Verified ready-to-deploy or merged truth SHALL continue to
supersede recovery through normal forward repair.

#### Scenario: Open PR and needs-human label preserve blocked recovery
- **WHEN** the ledger item is `blocked` with a started recovery attempt
- **AND** live observation reports an open PR and `pipeline:needs-human`
- **THEN** reconciliation SHALL record no `ledger-behind` drift from PR existence alone
- **AND** the item SHALL remain blocked with the same started attempt and budget

#### Scenario: Restart replays the same attempt
- **WHEN** a supervisor resumes the blocked item after the prior process stranded an attempt as `started`
- **AND** the same candidate PR remains open
- **THEN** the supervisor SHALL reconcile and re-enter that attempt identity
- **AND** SHALL NOT charge another attempt or replay a completed model side effect

#### Scenario: Ready truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with the ready-to-deploy label
- **THEN** reconciliation SHALL repair the item forward to `ready`
- **AND** SHALL terminalize the obsolete started attempt as superseded

#### Scenario: Merged truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with a merged PR
- **THEN** reconciliation SHALL repair the item forward to `merged`

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

### Requirement: Resume-only terminal ledger-behind catch-up SHALL remain reachable on a recovery_exhausted stop

A resume-only catch-up pass SHALL repair `ledger-behind` drift to verified `ready` or `merged` when the durable run records strategy-cursor exhaustion (`recovery_exhausted` historical evidence or Cooling) and the caller is `--resume`. Default reconciliation SHALL keep refusing when a true terminal `ledger.stop` is set for non-exhaustion reasons. A live drive that first records `recovery_exhausted` SHALL remain in Cooling or an external-condition wait and SHALL NOT become a terminal run stop solely for that exhaustion. The catch-up SHALL NOT merge, push, label-write, or otherwise mutate GitHub as part of that repair. The catch-up SHALL NOT treat `needs-human` as `ready`. The catch-up SHALL NOT reopen recovery budget for items whose verified identity is not `ready` or `merged`. The catch-up SHALL NOT apply the stranded `pr_opened` / `implemented` heal to `in_progress`. Other stop reasons keep their existing law: `run_fatal` resume remains the supersede-and-re-drive path.

#### Scenario: Blocked ledger plus ready-to-deploy identity repair-forwards on resume

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity reports ready-to-deploy (`ready_label_present`)
- **THEN** the catch-up SHALL repair-forward that item to ledger `ready`
- **AND** no GitHub write SHALL be recorded through the injected seam

#### Scenario: Blocked ledger plus merged identity repair-forwards on resume

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity reports the PR `merged`
- **THEN** the catch-up SHALL repair-forward that item to ledger `merged`

#### Scenario: Stop alone is not a bar on resume terminal catch-up

- **WHEN** `--resume` catch-up would classify `ledger-behind` to verified `ready` or `merged`
- **AND** the only reason that pass would otherwise skip is `ledger.stop.reason = recovery_exhausted` or equivalent Cooling evidence
- **THEN** the catch-up SHALL still apply the repair
- **AND** it SHALL NOT no-op solely because that evidence is set
- **AND** default `reconcile()` SHALL still refuse when a true non-exhaustion `ledger.stop` is set

#### Scenario: Default reconcile keeps the stop guard

- **WHEN** a caller invokes default `reconcile()` on a run whose ledger carries a true terminal `stop.reason` other than strategy-cursor exhaustion
- **AND** that caller is not the resume-only catch-up pass
- **THEN** reconciliation SHALL refuse because the run is already stopped
- **AND** it SHALL NOT repair-forward items through that default entry

#### Scenario: Live exhaustion remains Cooling rather than a terminal stop

- **WHEN** a live drive first records `recovery_exhausted`
- **THEN** that drive SHALL remain in Cooling or an external-condition wait
- **AND** it SHALL NOT become a terminal run stop solely for that exhaustion
- **AND** it SHALL NOT enter the resume-only GitHub-ready catch-up as a substitute for Cooling

#### Scenario: Non-terminal blocked identity is not catch-up to ready

- **WHEN** the ledger records an item as `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** `--resume` runs the catch-up pass
- **AND** the verified identity does not report ready-to-deploy or merged
- **THEN** the catch-up SHALL NOT repair-forward that item to `ready` or `merged`

#### Scenario: Next identical exhausted-stop catch-up needs no new mole

- **WHEN** a later run records `recovery_exhausted` with a blocked ledger item whose live identity is ready-to-deploy
- **AND** an operator runs `--resume`
- **THEN** the same catch-up SHALL persist ledger `ready`
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue
