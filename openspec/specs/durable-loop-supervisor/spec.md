# durable-loop-supervisor Specification

## Purpose
TBD - created by archiving change in-repo-loop-supervisor. Update Purpose after archive.

## Requirements

### Requirement: The supervisor SHALL drive a compiled run to a terminal condition through the durable engine

The durable loop supervisor SHALL be an Agent Pipeline-owned in-repo runtime that, given an
already-compiled and locked run, advances that run by repeating a bounded cycle: reconcile live
truth, reconcile any `started` recovery attempt, select the next dependency-ready active
item honoring the contract's active-item limit, dispatch that whole item, reconcile the dispatch
outcome against fresh live truth, execute any safe claimed recovery action before Cooling or
typed-request classification, and record the resulting resume, wait, hold, completion, Cooling, or
authenticated cancellation through the
durable engine. The supervisor SHALL continue until every item is done or abandoned, a genuine
current human-authority hold leaves no sibling able to progress, or every remaining mechanical
item is Cooling or waiting on an external condition. Bounded recovery exhaustion SHALL enter
Cooling. It SHALL NOT record an engine-owned mechanical terminal stop. The supervisor SHALL NOT invoke or depend on an
external goal-loop skill and SHALL NOT create a second ledger, lock, run-id namespace, or run
directory.

#### Scenario: A locked run advances to completion in-repo

- **WHEN** the supervisor is attached to a compiled, locked run whose items are executable or
  mechanically recoverable
- **THEN** it SHALL execute and recover items in dependency order until a genuine terminal
  condition or owned Cooling or wait
- **AND** no subprocess invocation of an external goal-loop skill or state CLI SHALL occur

#### Scenario: The run halts only after terminal reconciliation

- **WHEN** a cycle appears to reach completion, a human hold, Cooling, or an engine-owned wait
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

#### Scenario: Mechanical exhaustion cools rather than terminalizing the run

- **WHEN** bounded recovery for an engine-owned item is exhausted
- **THEN** the supervisor SHALL persist Cooling or an external-condition wait for that item
- **AND** SHALL NOT persist `run_fatal`, `recovery_exhausted`, `supervisor_no_progress`,
  `supervisor_cycle_cap`, or `worktree_capacity` as a lifecycle terminal stop

---

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

### Requirement: The supervisor SHALL persist a process-identity record with a refreshed heartbeat

The supervisor SHALL write a durable process-identity record in the run directory when it attaches
to a run, carrying the engine, the process id, the hostname, a per-boot identifier, the start time,
a heartbeat time, and the held lock token. It SHALL refresh the heartbeat time on a periodic process
cadence independently of cycle completion, and it SHALL still refresh on every cycle. The cadence
and the stale threshold SHALL be versioned engine safety invariants. Repository configuration SHALL
NOT lengthen the cadence or raise the stale threshold beyond those invariants. Pack-loop liveness
consumers SHALL treat a heartbeat older than the engine stale threshold as not-live even when a
cycle is still in flight. The record SHALL be distinct from the run lock — the lock governs write
authority; the process record identifies which supervisor process is currently driving and whether
it is still alive and progressing. The record SHALL be written through the store's injectable seam
so a unit test drives it with no real process, network, or git call.
Heartbeat writes SHALL require current lock ownership. A heartbeat timer
SHALL be started after attach through an injectable timer seam and SHALL
be cleared when the drive ends. Missing `heartbeat_at` after acknowledgement
SHALL be not-live. A malformed or future `heartbeat_at` SHALL be unreadable
identity: unknown inside the observation window, then fail closed.

#### Scenario: The process record is written at attach and heartbeats each cycle

- **WHEN** the supervisor attaches to a run and then completes cycles
- **THEN** a process-identity record carrying the engine, pid, hostname, per-boot id, start time,
  heartbeat time, and lock token SHALL exist in the run directory
- **AND** its heartbeat time SHALL advance on each subsequent cycle

#### Scenario: Heartbeat advances during a long in-flight cycle

- **WHEN** the supervisor is inside a cycle that lasts longer than the engine heartbeat cadence
- **THEN** `heartbeat_at` SHALL still advance before that cycle completes
- **AND** a liveness consumer SHALL NOT classify the process as stale solely because the cycle
  has not finished

#### Scenario: Repository config cannot weaken the stale threshold

- **WHEN** repository configuration attempts to raise the heartbeat stale threshold or lengthen
  the cadence beyond the engine invariant
- **THEN** the engine SHALL keep the versioned invariant
- **AND** pack-loop liveness SHALL still use that invariant

#### Scenario: The process record composes with, and does not replace, the lock

- **WHEN** a supervisor holds the run
- **THEN** both the run lock and the process-identity record SHALL be present
- **AND** the process record SHALL NOT be treated as a second write-authority lock

#### Scenario: Missing heartbeat after acknowledgement is not live

- **WHEN** bound loop `L` has a valid `loop_run_handoff`
- **AND** `supervisor.json` omits `heartbeat_at` or the field is empty
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Malformed or future heartbeat fails closed after the observation window

- **WHEN** `heartbeat_at` is not a parseable timestamp
- **OR** `heartbeat_at` is more than one second in the future
- **AND** the observation window has expired
- **THEN** liveness SHALL be fail-closed identity error
- **AND** it SHALL NOT count as fresh

#### Scenario: Heartbeat timer is cleared when drive ends

- **WHEN** `driveSupervisor` returns or throws
- **THEN** the injected heartbeat timer SHALL be cleared
- **AND** a later fake tick SHALL NOT write `supervisor.json`

### Requirement: The supervisor SHALL detect no-progress and stop rather than spin

The supervisor SHALL classify each cycle as making progress — a durable delta such as an item
transition, a reconciliation change, a recovery attempt, a new block or hold, or Cooling — or as
making no progress. After a bounded number of consecutive no-progress cycles it SHALL persist
Cooling with a future `next_eligible_at` rather than continuing to
cycle. This run-level cycle watchdog SHALL be distinct from, and compose with, the item-level
repeated-evidence bound the recovery policy already enforces; neither SHALL disable the other.
Neither watchdog SHALL persist `supervisor_no_progress` or `supervisor_cycle_cap` as a lifecycle
terminal stop.

#### Scenario: A spinning run stops instead of looping unbounded

- **WHEN** consecutive cycles produce no durable delta — no eligible item, no drift, no recovery
  attempt, no hold — up to the configured consecutive-no-progress bound
- **THEN** the supervisor SHALL persist Cooling with a future `next_eligible_at`
- **AND** it SHALL stop cycling rather than continue indefinitely
- **AND** the Logical Operation SHALL remain owned

#### Scenario: A progressing cycle resets the no-progress count

- **WHEN** a cycle records a durable delta after one or more no-progress cycles
- **THEN** the consecutive-no-progress count SHALL reset
- **AND** the run SHALL continue

#### Scenario: Cycle safety cap cools rather than terminalizing

- **WHEN** the absolute cycle safety cap is reached while cycles still report progress
- **THEN** the supervisor SHALL persist Cooling or an external-condition wait
- **AND** SHALL NOT persist `supervisor_cycle_cap` as a lifecycle terminal stop

---

### Requirement: The supervisor SHALL record an append-only action-evidence trail

The supervisor SHALL append one durable action-evidence entry per cycle to an append-only log in the
run directory, carrying a monotonically increasing sequence number, the time, the item acted on (or
an explicit none), the action taken, the resulting outcome or next action, and the progress
classification for that cycle. The trail SHALL be reconstructable in order so a resuming process or
an auditor can determine exactly what the supervisor did, including across a process restart. The log
SHALL be append-only — entries SHALL NOT be rewritten or removed — and SHALL be written under the run
lock token.

#### Scenario: Each cycle appends one ordered evidence entry

- **WHEN** the supervisor completes a sequence of cycles
- **THEN** the action-evidence log SHALL contain one entry per cycle with strictly increasing
  sequence numbers
- **AND** each entry SHALL record the item acted on or an explicit none, the action, the
  outcome/next-action, and the progress classification

#### Scenario: The trail is append-only

- **WHEN** a new action-evidence entry is written
- **THEN** it SHALL be appended after the existing entries
- **AND** no prior entry SHALL be rewritten or removed

---

### Requirement: Resume SHALL take over a run only when the prior supervisor is provably gone

`--resume <run-id>` SHALL attach a fresh supervisor to an existing run only when the prior holder is
provably gone by the durable store's existing rules — the lock is released, or the lock is held by a
dead process id on the same host and is recovered through the store's provably-dead recovery path.
Before resuming execution the supervisor SHALL run a reconciliation pass so it acts on verified live
truth, SHALL reconcile outstanding Recovery Episode claims whose certainty is uncertain before any
new mutation, SHALL record a resume marker in the action-evidence trail, and SHALL continue from the
ledger's current position without creating a second run, lock, run-id, or run directory. When the
ledger carries historical `stop.reason = run_fatal` evidence, the supervisor SHALL treat that record
as owned Cooling or wait evidence and SHALL apply catch-up for valid outstanding items instead of
treating that stop as the first cycle result. A run whose recorded contract or ledger schema id is
outside the store's supported set SHALL be refused before any takeover.

#### Scenario: A dead-holder run is resumed after reconciliation

- **WHEN** `--resume <run-id>` targets a run whose lock is held by a same-host dead pid
- **THEN** the supervisor SHALL recover the lock through the store's provably-dead path, run a
  reconciliation pass, and continue from the ledger's current position
- **AND** it SHALL record a resume marker in the action-evidence trail and create no second run,
  lock, or run directory

#### Scenario: A released-lock run is resumed

- **WHEN** `--resume <run-id>` targets a run whose prior supervisor released the lock
- **THEN** the supervisor SHALL acquire the lock and continue the run from its current ledger position

#### Scenario: A run_fatal stop is not a silent resume no-op

- **WHEN** `--resume <run-id>` targets a run whose lock is free and whose ledger carries
  historical `stop.reason = run_fatal` evidence
- **THEN** the supervisor SHALL NOT complete the drive solely by re-emitting that stop with
  `resumed` true and zero item dispatches
- **AND** it SHALL reconcile claims and continue owned work or catch-up at the same run id

#### Scenario: Takeover observes uncertain claims before mutation

- **WHEN** resume takes over a dead same-host holder
- **AND** a Recovery Episode claim is `started` with uncertain certainty
- **THEN** the supervisor SHALL query the authoritative observer before any new mutation
- **AND** SHALL NOT replay a side effect whose observer proves complete

---

### Requirement: Resume SHALL refuse a run whose supervisor is still alive

`--resume <run-id>` SHALL refuse to attach a second supervisor when the run's lock holder is still
alive — a live process id with a fresh heartbeat on the same host, or a holder whose liveness cannot
be verified because it is on a different host. In that case the command SHALL exit non-zero, surface
the existing holder, and perform no ledger write, no lock acquisition, no process-record write, and
no GitHub mutation. Cross-host unverifiable liveness SHALL be treated as not-recoverable, never as
dead, consistent with the documented single-host concurrency scope.

#### Scenario: A live same-host holder is not duplicated

- **WHEN** `--resume <run-id>` targets a run whose lock is held by a live same-host process
- **THEN** the command SHALL exit non-zero and report the existing holder
- **AND** the injected write seams SHALL record no lock acquisition, no ledger write, no
  process-record write, and no GitHub mutation

#### Scenario: A cross-host holder is treated as unrecoverable

- **WHEN** `--resume <run-id>` targets a run whose lock holder is on a different host and its liveness
  cannot be verified
- **THEN** the command SHALL refuse rather than assume the holder is dead
- **AND** it SHALL create no second supervisor

---

### Requirement: Audit mode SHALL be read-only and surface the supervisor timeline

`--audit` SHALL render a read-only report for an existing run drawn from the run's durable artifacts —
the current or last process-identity record, the action-evidence timeline, the watchdog / no-progress
state, and the run's current position — and SHALL perform no durable write of any kind: no ledger
write, no lock acquisition, no process-identity write, and no GitHub mutation. Audit SHALL NOT start
or resume the run, and its output SHALL be derivable entirely from already-persisted artifacts.

#### Scenario: Audit reports the supervisor timeline without mutation

- **WHEN** `--audit` is invoked for an existing run
- **THEN** it SHALL print the process identity, the action-evidence timeline, the watchdog /
  no-progress state, and the run's current position
- **AND** through the injected seams it SHALL record no ledger write, no lock acquisition, no
  process-identity write, and no GitHub mutation

#### Scenario: Audit of a run that never attached a supervisor

- **WHEN** `--audit` is invoked for a run that has no process-identity record yet
- **THEN** it SHALL report the absent process identity without error
- **AND** it SHALL still print whatever action-evidence and position the run has recorded

---

### Requirement: The loop run-start path SHALL NOT require an external goal-loop skill

The `pipeline loop` run-start path SHALL drive the in-repo supervisor and SHALL NOT discover,
require, or invoke an installed external goal-loop skill; its run-start preflight SHALL use the
in-repo durable loop store's schema-compatibility check rather than an external
contract-coherence discovery. The absence of any installed goal-loop skill SHALL NOT fail the
preflight or the run. The documented read-only legacy-run import path SHALL remain available so a
pre-existing run created by a legacy invocation stays addressable by run id.

#### Scenario: A host with no goal-loop skill installed still runs

- **WHEN** `pipeline loop <selector>` is invoked on a host with no goal-loop skill installed at any
  root
- **THEN** the preflight SHALL pass its store-compatibility check and the supervisor SHALL start,
  execute, and report a run id
- **AND** no install-remediation failure SHALL be produced on any path

#### Scenario: A legacy run remains addressable by id

- **WHEN** `--resume <run-id>` names a run created by a legacy goal-loop invocation
- **THEN** it SHALL address that run's contract, ledger, and history through the documented import
  path
- **AND** it SHALL NOT create a second run for that id

### Requirement: The supervisor SHALL record durable advance-run linkage for each dispatched item

The supervisor SHALL append a durable start-linkage event (or equivalent durable handoff
field in the authoritative loop run directory) when it dispatches an item through
`pipeline/loop-execution@1` and the per-item advance run-store identity is known, carrying
at least `item_id`, the real advance `pipeline_run_id`, and the absolute advance
`events.jsonl` path when known. The supervisor SHALL append a durable terminal-linkage
event when the dispatch returns a terminal outcome, carrying the same `item_id` and real
`pipeline_run_id` (and events path when known) plus the terminal outcome. These records
SHALL be written through the store's injectable seam so unit tests drive them with no
real process, network, or git call. The supervisor SHALL continue to hand off whole items
only and SHALL NOT own pipeline stage labels or merge.

#### Scenario: Start linkage is durable on the loop run

- **WHEN** the supervisor dispatches an item whose advance run-store id is known
- **THEN** the loop run's durable event trail SHALL contain a start-linkage record with
  that item's id, the real advance `pipeline_run_id`, and the absolute events path when
  known
- **AND** the record SHALL be readable after a supervisor process restart from the same
  run directory

#### Scenario: Terminal linkage includes outcome

- **WHEN** the dispatch for that item returns a contract terminal outcome
- **THEN** the loop run's durable event trail SHALL contain a terminal-linkage record with
  the same item and advance run ids and that outcome
- **AND** audit SHALL be able to join the supervisor trail to
  `.agent-pipeline/runs/<pipeline_run_id>/events.jsonl` using those fields

#### Scenario: Coarse item events are not the only join surface

- **WHEN** a harness follows only supervisor events for an in-flight item
- **THEN** it SHALL obtain the advance run join key from the start-linkage record rather
  than inferring it from `loop_item_started` alone or from a synthetic
  `pipeline-loop-…` evidence id

#### Scenario: Linkage writes use the injectable store seam

- **WHEN** a unit test injects a fake store and a fake dispatch that reports a known
  advance run id
- **THEN** the start and terminal linkage records SHALL appear via that seam without a
  real subprocess or filesystem run store

### Requirement: The supervisor SHALL update per-item current-stage from observed advance evidence during dispatch

While the supervisor is advancing an item through `pipeline/loop-execution@1` and a real advance run store is linked and confirmed, the supervisor SHALL observe that store's stage-relevant events (or an equivalent injected advance-progress seam) and update the item's durable current-stage projection on material stage or round changes. The supervisor SHALL append a structured stage-progress event on the loop run's event trail for each material update. The supervisor SHALL continue to hand off whole items only: it SHALL NOT write GitHub pipeline stage labels, SHALL NOT expose or call any per-stage verb, and SHALL NOT merge.

#### Scenario: Mid-advance stage observation updates the ledger projection

- **WHEN** the supervisor is waiting on a dispatched item whose linked advance run emits `stage_start` for `plan-review`
- **THEN** the item's durable current-stage projection SHALL update to `plan-review` (with round when the advance evidence supplies one)
- **AND** a structured stage-progress event for that item SHALL appear on the loop run event trail

#### Scenario: Supervisor still does not own stage labels

- **WHEN** the supervisor updates current-stage for an item from advance evidence
- **THEN** every GitHub `pipeline:*` label transition for that item SHALL still originate in the per-item advance
- **AND** the supervisor SHALL issue no stage-label write of its own

#### Scenario: Observation uses the injectable seam

- **WHEN** a unit test injects a fake advance-progress reader and a fake store
- **THEN** material fake stage events SHALL produce ledger projection updates and loop stage-progress events without a real child process or network call

---

### Requirement: Audit mode SHALL include the per-item stage table in its read-only report

`--audit` SHALL include a per-item stage-progress section (table or equivalent structured listing) drawn from durable artifacts: each item's id, current-stage presentation (or queued/pending when not mid-advance), and advance run-id when known. This section is in addition to process identity, action-evidence timeline, watchdog / no-progress state, and run position. Audit SHALL remain fully read-only.

#### Scenario: Audit report carries stage table fields

- **WHEN** `--audit` is invoked for an existing run with at least one item that has a recorded current-stage and advance run id
- **THEN** the audit report SHALL include that item's stage and advance run id in the stage-progress section
- **AND** through injected seams it SHALL record no ledger write, no lock acquisition, no process-identity write, and no GitHub mutation

#### Scenario: Audit of items without stage data still succeeds

- **WHEN** `--audit` is invoked for a run whose items lack current-stage projections
- **THEN** it SHALL still print the existing supervisor timeline and position
- **AND** the stage section SHALL present pending/unknown/queued items without failing the audit

### Requirement: Supervisor resume SHALL re-drive mid-pipeline items that remain in_progress after reconciliation

After `--resume <run-id>` attaches (including dead-holder lock recovery on the same host), the supervisor SHALL run reconciliation and then continue cycling. When reconciliation leaves an item in `in_progress` because live GitHub still shows mid-flight `pipeline:*` work (open PR or not), the supervisor SHALL re-dispatch that item through `pipeline/loop-execution@1` so advance continues from the issue's current stage labels. The supervisor SHALL NOT skip such an item solely because an open PR with green checks exists, and SHALL NOT prefer an unrelated `pending` sibling while a mid-pipeline `in_progress` item is still active and eligible for re-dispatch. Supervisor-level regression tests SHALL assert the execution seam call trace (`dispatchItem` / equivalent), not only final ledger state.

#### Scenario: Resume re-dispatches in_progress mid-flight item after crash

- **WHEN** a run is resumed after a mid-item crash with ledger state `in_progress` for item N and live labels still mid-pipeline (e.g. `pipeline:fix-2`)
- **AND** reconciliation does not demote item N to stranded `pr_opened`
- **THEN** the supervisor cycle SHALL re-dispatch item N through `pipeline/loop-execution@1`
- **AND** it SHALL NOT leave item N idle while only selecting a different `pending` sibling

#### Scenario: Open PR with green checks does not strand an active mid-pipeline item

- **WHEN** the active cycle's reconciliation observes item N as mid-flight with an open PR and checks `success` while ledger state remains `in_progress`
- **THEN** the supervisor SHALL treat item N as still active work and re-dispatch it
- **AND** SHALL NOT require a human `/pipeline N` outside the loop solely to continue that item

#### Scenario: Active mid-flight item is re-dispatched before pending sibling selection can displace it

- **WHEN** the ledger has item A `in_progress` with mid-flight open-PR identity and item B `pending`
- **AND** a supervisor cycle runs after reconciliation under injected seams
- **THEN** the execution call trace SHALL include a dispatch for item A
- **AND** the cycle SHALL NOT demote A to non-dispatchable `pr_opened` and then only start B

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

### Requirement: The supervisor SHALL treat host-local lock and already-running dispatch failures as non-fatal coexistence

When per-item execution returns a `failed` (or unrecognized) outcome whose evidence indicates a host-local lock collision, already-running advance, or install-in-progress mutual exclusion for that item, the supervisor SHALL apply a non-fatal coexistence disposition — attach, wait, skip, or equivalent non-terminal progress — rather than recording the item as `blocked` under `workflow-engine-defect` and rather than recording a `run_fatal` stop for the run. This path SHALL compose with existing Pass-2 safety nets (precondition no-op exclusion and needs-human `pipeline:blocked` hold) and SHALL run as an explicit branch before the default genuine-defect classification. An outcome outside the defined terminal set that carries no coexistence evidence and no needs-human blocked disposition SHALL still be recorded as `failed` and classified under existing `workflow-engine-defect` / `run_fatal` policy.

#### Scenario: Lock collision does not run_fatal a multi-item run

- **WHEN** the supervisor dispatches item `675` and the execution seam reports failure with already-running or lock-held evidence
- **THEN** the supervisor SHALL NOT record `stop.reason = run_fatal` for that outcome
- **AND** it SHALL NOT set the item's blocked theme to `workflow-engine-defect`
- **AND** sibling items that are still schedulable or already `ready` SHALL remain eligible for continuation or disclosure under existing rules

#### Scenario: Unrecognized outcome without coexistence evidence stays failed

- **WHEN** per-item execution reports an outcome outside the defined terminal set
- **AND** no lock-held, already-running, install-in-progress, precondition no-op, or `pipeline:blocked` needs-human evidence applies
- **THEN** the supervisor SHALL record the item as `failed` under existing policy
- **AND** `workflow-engine-defect` / `run_fatal` SHALL apply unchanged

#### Scenario: Coexistence wait does not disable the no-progress watchdog

- **WHEN** the supervisor repeatedly applies a coexistence wait for the same item across cycles
- **AND** no durable progress is recorded (no new coexistence evidence, no terminal advance, no other item transitions)
- **THEN** the existing consecutive no-progress / supervisor watchdog bounds SHALL still be able to stop the run
- **AND** a cycle that newly records durable coexistence evidence or advance progress SHALL count as progress under existing progress classification

### Requirement: The supervisor SHALL execute recovery before hold or stop classification

After every blocked or failed dispatch, the supervisor SHALL reconcile the item's current live
identity and diagnostic, project its recovery disposition, and consult the durable attempt ledger
before recording a hold, Cooling, or typed request. For an engine-owned recoverable disposition, it SHALL claim and
charge a permitted applicable recipe before side effects, execute it, and reconcile its result. Only a
current canonical `human-decision-required` diagnostic SHALL permit an immediate human hold.
Exhausted or unrecoverable engine-owned work SHALL enter Cooling or an external-condition wait.
It SHALL NOT permit a mechanical terminal system stop.

The supervisor SHALL, before claiming any recovery attempt for an item, consult the host-local
live-advance probe for that item AND acquire the same per-issue advance lock the advance path
uses, holding that lock for the entire recovery executor run. A live probe or an unavailable
lock SHALL defer that item's recovery for the current cycle without charging any recovery
budget, while sibling items continue to be scheduled and recovered unaffected.

#### Scenario: Failed dispatch recovers before run-fatal

- **WHEN** a dispatch returns an engine-owned diagnostic with safe per-strategy recipe budget remaining
- **THEN** the supervisor SHALL execute the recovery flow before persisting Cooling
- **AND** success SHALL re-enter the same item through normal whole-item execution

#### Scenario: Failed recovery remains charged and bounded

- **WHEN** a claimed recovery action fails
- **THEN** the supervisor SHALL persist the failed result against the charged claim
- **AND** it SHALL retry only while that strategy's bound permits, then advance the cursor or enter
  Cooling

#### Scenario: Blocked label alone does not create a hold

- **WHEN** fresh live truth contains `pipeline:blocked` but dispatch evidence has no current valid
  `human-decision-required` diagnostic
- **THEN** the supervisor SHALL NOT create a human hold from the label alone
- **AND** it SHALL classify the diagnostic as engine-owned recovery or Cooling

#### Scenario: A live concurrent advance defers recovery without charging budget

- **WHEN** a blocked item is eligible for recovery but the live-advance probe reports a concurrent
  host-local advance on that item
- **THEN** the supervisor SHALL defer that item's recovery for the cycle without claiming or
  charging any recovery budget
- **AND** sibling items SHALL continue to be scheduled and recovered

#### Scenario: An unavailable per-issue advance lock defers recovery without charging budget

- **WHEN** the probe reports no live advance but the per-issue advance lock the advance path uses
  cannot be acquired
- **THEN** the supervisor SHALL defer that item's recovery for the cycle without charging budget
- **AND** when the lock is acquired the supervisor SHALL hold it for the entire recovery executor
  run before releasing it

---

### Requirement: Every terminal driver exit SHALL emit one durable terminal event

The supervisor SHALL persist exactly one terminal event kind before it exits with a verified-complete or authenticated-cancellation run result. Existing stop transitions for genuine human-authority holds SHALL continue to append `loop_run_stopped` or `loop_run_complete` with their final item accounting. Mechanical exhaustion, process death, no-progress, capacity, and cycle-cap SHALL persist Cooling or wait evidence. They SHALL NOT emit a terminal stop event that ends ownership. A process interruption while recovery remains possible SHALL NOT emit a terminal event. Re-entry SHALL not duplicate an already persisted terminal event for the same terminal revision.

#### Scenario: Completed run emits completion event

- **WHEN** every item reconciles to done or abandoned and the driver exits successfully
- **THEN** exactly one durable `loop_run_complete` event SHALL be appended before exit
- **AND** it SHALL carry the final item accounting

#### Scenario: Exhausted run emits stop event

- **WHEN** engine-owned recovery is exhausted
- **THEN** the supervisor SHALL persist Cooling or an external-condition wait
- **AND** it SHALL NOT append `loop_run_stopped` solely for that mechanical exhaustion
- **AND** the record SHALL distinguish Cooling from human authority

#### Scenario: Interrupted recoverable run is not terminal

- **WHEN** the supervisor process is interrupted while an item remains recoverable
- **THEN** the supervisor SHALL NOT emit a terminal completion or stop event
- **AND** the run SHALL remain resumable

---

### Requirement: One-item drives SHALL use the same durable supervisor

The default host-facing single-issue drive SHALL compile a one-item work-list and execute it through
the same durable supervisor, diagnostic projection, recovery policy, attempt ledger, and terminal
event contract as a multi-item drive. Mutating `pipeline <N>` and `pipeline single <N>` SHALL both
be that default host-facing one-item drive. A later invocation SHALL resume an active canonical run and
SHALL mint a linked superseding run only when the canonical chain head is terminally stopped, so an
exhausted ledger is never silently reused as a fresh attempt budget. Nested whole-item advancement
spawned by that supervisor SHALL NOT create or attach to a second durable supervisor.

#### Scenario: A blocked single issue enters recovery before returning

- **WHEN** a host invokes the default pipeline skill for one issue whose current state is blocked
- **THEN** the host SHALL start the durable one-item controller rather than a detached raw advance
- **AND** the supervisor SHALL execute eligible recovery before returning a terminal result

#### Scenario: Successful one-item completion is observable

- **WHEN** the one-item controller resolves the issue
- **THEN** it SHALL emit `loop_run_complete` through the material event stream
- **AND** the host SHALL retain and wait for the controller process through that terminal event

#### Scenario: Numeric syntax uses the same one-item controller

- **WHEN** a host invokes mutating `pipeline <N>` for one issue
- **THEN** the CLI SHALL start or attach to the same durable one-item controller as `pipeline single <N>`
- **AND** nested whole-item advancement SHALL NOT mint a second supervisor

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

### Requirement: Re-invoke of the same ship SHALL NOT reuse a dead loop into supervisor_no_progress

When a ship or train re-enters after a dead holder, the supervisor SHALL continue the same item from its last durable stage. Reusing a prior loop run id whose holder is dead SHALL NOT keep that run in a wait cycle. The supervisor SHALL NOT record stop reason `supervisor_no_progress` because a dead prior run produced `coexistence_wait` or a leftover `workflow-engine-defect`. A new or continued driver MAY attach to live child identities that are still live; a corpse run is not live.

#### Scenario: Re-ship after kill does not stop supervisor_no_progress

- **WHEN** a prior loop run failed after SIGTERM and its holder is dead
- **AND** `pipeline ship --milestone` for the same milestone is invoked again
- **THEN** the supervisor SHALL resume the same issue
- **AND** it SHALL NOT stop with reason `supervisor_no_progress`

#### Scenario: Reused corpse run id is not a live wait

- **WHEN** the only recorded loop id for the item is a prior run whose holder is dead
- **THEN** the supervisor SHALL NOT treat that run id as a live coexistence holder
- **AND** it SHALL take over the item instead of waiting on that id

### Requirement: Leftover recovered block SHALL NOT stop a later ready-to-deploy ship item

When live labels include `pipeline:ready-to-deploy` and do not include `blocked`, and #1095 recovered-block classification is ok, a ship or merge-mode train SHALL merge that item. A leftover `loop_item_blocked` event or leftover `blocked_theme` on a ready ledger item SHALL NOT STOP the ship and SHALL NOT cause the driver to implement a newer sibling instead.

#### Scenario: Leftover implementation-ci plus live R2D merges

- **WHEN** ship or `train --merge` observes issue A with live `pipeline:ready-to-deploy`, no live `blocked`, an open MERGEABLE PR, and a leftover `loop_item_blocked` / `blocked_theme`
- **THEN** it SHALL merge A
- **AND** it SHALL NOT STOP the ship solely for that leftover block
- **AND** it SHALL NOT implement a newer sibling while A's PR remains open

### Requirement: Operator resume of a run_fatal stop SHALL re-drive valid outstanding items or refuse distinctly

The supervisor SHALL classify outstanding items against live observed identity when
`--resume <run-id>` attaches to a run whose ledger carries historical `stop.reason = run_fatal`
evidence, before it
emits `loop_drive_started` and before it dispatches any item. An item SHALL count as valid-outstanding
when all of the following hold: it is on the compiled contract; its ledger state is not
done, abandoned, or skipped; it is not under a current human-authority hold; live labels still
admit it under the existing loop precondition gate.

When at least one item is valid-outstanding, the supervisor SHALL supersede the historical
`run_fatal` evidence at
the same run id, run a fresh reconciliation, and re-drive those items through
`pipeline/loop-execution@1`. It SHALL NOT mint a second run, lock, run id, or run directory.

When no item is valid-outstanding, or live observation fails, the supervisor SHALL refuse with a
distinct non-success error that names the recorded stop `time`, `theme`, `item_id` when present, and
a recommended next command (audit the run; `--new-run` for the same selector). It SHALL NOT print
the terminal drive summary with `resumed` true and `dispatched` 0. It SHALL NOT emit
`loop_drive_started`. It SHALL NOT dispatch. It SHALL leave the original historical evidence in place
when refusal is required because every remaining item is a genuine human-authority hold.

A live drive that first records a mechanical class that previously mapped to `run_fatal` SHALL persist
Cooling or an external-condition wait. The supervisor SHALL NOT require a new operator `--resume`
invocation solely to keep ownership of that mechanical fault.

#### Scenario: Stale transient run_fatal with valid outstanding items re-drives in place

- **WHEN** `--resume <run-id>` targets a run stopped with historical `reason = run_fatal`
- **AND** at least one contract item is valid-outstanding (admitted label, not done or abandoned,
  no current human-authority hold)
- **THEN** the supervisor SHALL supersede that stop and dispatch at least one valid-outstanding
  item through `pipeline/loop-execution@1`
- **AND** the `run_id` SHALL be the resumed run's id (no second run directory)

#### Scenario: Fresh preflight runs before re-drive dispatch

- **WHEN** a historical `run_fatal` resume is eligible to re-drive
- **THEN** the supervisor SHALL reconcile live truth after the stop is superseded and before the
  first re-drive dispatch
- **AND** it SHALL NOT dispatch using only the pre-stop ledger snapshot as live truth

#### Scenario: Ineligible run_fatal resume refuses instead of zero-dispatch success

- **WHEN** `--resume <run-id>` targets a run stopped with historical `reason = run_fatal`
- **AND** no contract item is valid-outstanding
- **THEN** the command SHALL exit as a distinct error naming the recorded stop `time` and `theme`
- **AND** it SHALL NOT print a terminal drive summary with `resumed` true and `dispatched` 0
- **AND** the item-dispatch seam SHALL NOT be called
- **AND** historical `run_fatal` evidence SHALL remain

#### Scenario: Observe failure fail-closes to refusal

- **WHEN** `--resume <run-id>` targets a run stopped with historical `reason = run_fatal`
- **AND** live observation of outstanding items fails
- **THEN** the command SHALL refuse without clearing historical `run_fatal` evidence
- **AND** it SHALL NOT dispatch any item

#### Scenario: Re-drive that fatals again is a new stop, not a silent no-op

- **WHEN** a `run_fatal` resume re-drives a valid-outstanding item
- **AND** that dispatch exhausts applicable strategies
- **THEN** RecoverySupervisor SHALL persist Cooling or an external-condition wait
- **AND** SHALL NOT persist a new `run_fatal` lifecycle stop
- **AND** the item-dispatch seam SHALL have been called for that drive

#### Scenario: Live-drive run_fatal policy is unchanged

- **WHEN** a live supervisor (not a resume of an already-recorded `run_fatal`) records a
  mechanical class that previously mapped to `run_fatal`
- **THEN** it SHALL persist Cooling or an external-condition wait
- **AND** SHALL NOT persist `stop.reason = run_fatal` as the lifecycle outcome
- **AND** it SHALL NOT require a later operator `--resume` solely to retain ownership

#### Scenario: Human-authority hold is not valid-outstanding

- **WHEN** `--resume <run-id>` targets a run stopped with historical `reason = run_fatal`
- **AND** every remaining non-done item is under a current human-authority hold
- **THEN** the command SHALL refuse distinctly
- **AND** it SHALL NOT re-drive those held items

---

### Requirement: Resume of recovery_exhausted SHALL repair-forward GitHub-ready items

`--resume` of a durable loop whose ledger records strategy-cursor exhaustion (`recovery_exhausted` historical evidence or Cooling) SHALL run a resume-only catch-up pass. That pass SHALL observe live identity through the existing observe seam and SHALL repair-forward each contract item whose verified identity is `ready` or `merged`. The supervisor SHALL NOT complete that resume as a no-op solely because `ledger.stop` is set or because Cooling is recorded. After that catch-up, each such item SHALL be ledger `ready` (or `merged`) without a human deleting `ledger.stop` or rewriting item JSON. Historical `recovery_exhausted` evidence MAY remain. Resume SHALL NOT grant extra recovery budget for remaining blocked items whose verified identity is not `ready` or `merged`. Resume SHALL NOT treat `needs-human` as ready. Resume SHALL NOT merge pack PRs. Resume SHALL NOT mutate GitHub. Resume SHALL NOT use a mechanical `run_fatal` supersede-and-re-drive path for a `recovery_exhausted` record. A live drive that records strategy-cursor exhaustion SHALL remain in Cooling (or an external-condition wait) and SHALL NOT become a terminal run stop, ownerless terminal, or human hold solely for that exhaustion. Independent siblings SHALL remain schedulable while that item cools.

#### Scenario: Resume repair-forwards after exhausted stop

- **WHEN** pack ledger item `#1290` has `state` `blocked`
- **AND** the run records `recovery_exhausted` historical evidence or Cooling
- **AND** the verified identity for `#1290` reports `pipeline:ready-to-deploy` (ready label present)
- **AND** `pipeline loop --resume` attaches to that pack run
- **THEN** the supervisor SHALL run repair-forward for `#1290`
- **AND** `#1290` SHALL become ledger `ready` (or equivalent terminal ready state)
- **AND** the operator SHALL NOT need to delete `ledger.stop` or rewrite item JSON
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: Resume does not no-op solely because stop is set

- **WHEN** `--resume` targets a run whose ledger carries `stop.reason = recovery_exhausted` or equivalent Cooling evidence
- **AND** at least one contract item has verified identity `ready` or `merged` while the ledger still records a non-terminal local state including `blocked`
- **THEN** the supervisor SHALL NOT return with zero catch-up solely because `ledger.stop` is set
- **AND** it SHALL persist the terminal ledger state for that item

#### Scenario: Remaining non-ready blocked items keep recovery exhaustion

- **WHEN** `--resume` repair-forwards a GitHub-ready item on a `recovery_exhausted` record
- **AND** another contract item remains `blocked` without verified identity `ready` or `merged`
- **THEN** the supervisor SHALL NOT treat that remaining item as ready
- **AND** that remaining item SHALL stay in Cooling or an external-condition wait
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: needs-human is not repair-forwarded to ready

- **WHEN** `--resume` targets a run with `recovery_exhausted` historical evidence or Cooling
- **AND** the verified identity reports `pipeline:needs-human` and does not report ready-to-deploy or merged
- **THEN** the supervisor SHALL NOT repair-forward that item to ledger `ready`

#### Scenario: Live drive that records recovery_exhausted stays stopped

- **WHEN** a live supervisor drive first records strategy-cursor exhaustion (`recovery_exhausted` evidence)
- **THEN** that live drive SHALL remain in Cooling or an external-condition wait
- **AND** it SHALL NOT become a terminal run stop, ownerless terminal, or human hold solely for that exhaustion
- **AND** it SHALL NOT run the resume-only GitHub-ready catch-up as a substitute for Cooling
- **AND** independent siblings SHALL remain schedulable

#### Scenario: run_fatal resume stays a distinct path

- **WHEN** `--resume` targets a run whose ledger carries historical `stop.reason = run_fatal` evidence
- **THEN** the supervisor SHALL apply the historical `run_fatal` resume requirement
- **AND** it SHALL NOT treat that record as `recovery_exhausted` catch-up only

#### Scenario: Repeated exhausted-stop resume is idempotent

- **WHEN** `--resume` has already repair-forwarded a GitHub-ready item on a `recovery_exhausted` record
- **AND** an operator runs `--resume` again on the same run with the same verified identity
- **THEN** that item SHALL remain ledger `ready` or `merged`
- **AND** the supervisor SHALL NOT dispatch new recovery or advance work solely because resume ran again
- **AND** historical `recovery_exhausted` evidence MAY remain

#### Scenario: Next identical exhausted-stop R2D resume needs no new mole

- **WHEN** a later pack loop records `recovery_exhausted` while GitHub already shows an item ready-to-deploy
- **AND** an operator runs `pipeline loop --resume` on that run
- **THEN** the same catch-up SHALL persist ledger `ready` for that item
- **AND** the operator SHALL NOT need a human `ledger.json` edit or a new mole issue

### Requirement: An acknowledged pack-loop process death SHALL allow one recorded resume

When an acknowledged pack-loop supervisor process dies while its run remains resumable and non-terminal, the engine SHALL allow exactly one durably recorded resume for that exact loop id. The resume budget SHALL be run-lineage scoped: persist `resume_count` on the binding for that `loop_run_id`. The failed process identity SHALL be recorded as audit evidence only. A second acknowledged liveness loss for that same loop SHALL be terminal even when the dead process has a new PID. The resumed process SHALL publish a new valid `loop_run_handoff` before it is treated as dispatched or live. Unreadable identity evidence SHALL NOT authorize that resume. The resume record SHALL persist under the run lock so a later invoke cannot claim a second grant.

#### Scenario: First acknowledged death resumes once

- **WHEN** bound loop `L` has a valid `loop_run_handoff`
- **AND** the acknowledged process is dead
- **AND** the run is resumable and non-terminal
- **AND** `resume_count` for `L` is 0
- **THEN** the engine SHALL spawn exactly one resume of `L`
- **AND** it SHALL persist `resume_count` 1 and the failed process identity as audit evidence
- **AND** the new process SHALL emit a new valid `loop_run_handoff` before `dispatch_state` is `dispatched`

#### Scenario: Second liveness loss is terminal

- **WHEN** loop `L` already has `resume_count` 1
- **AND** the resumed process dies or becomes not-live
- **THEN** the engine SHALL treat that liveness loss as terminal
- **AND** it SHALL NOT spawn another pack-loop child for `L`
- **AND** it SHALL NOT mint a new grant because the dead process has a new PID

#### Scenario: Unreadable identity does not grant resume

- **WHEN** `supervisor.json` or lock identity evidence for loop `L` is unreadable or malformed
- **THEN** the engine SHALL NOT record a resume grant from that evidence
- **AND** it SHALL apply the bounded observation window and then fail closed

### Requirement: Supervisor worker death SHALL NOT terminalize a durable loop run

The durable loop supervisor SHALL treat a dead worker, stale heartbeat, or recovered same-host dead-pid lock as lost physical liveness, not as a terminal run stop. After the Liveness Provider claims a fresh fence, the supervisor SHALL resume the same run identity through the existing attach/resume path. RecoverySupervisor SHALL still own recipe selection after the worker is restored. A dead worker SHALL NOT become `run_fatal`, verified completion, ownerless terminal, or human authority solely because the process exited.

#### Scenario: Dead-pid lock recovery keeps the run owned

- **WHEN** a loop run ledger is non-terminal and the lock holder pid is provably dead on this host
- **THEN** restore SHALL recover the lock and reattach the same supervisor
- **AND** the ledger SHALL NOT record a terminal stop solely from that death

#### Scenario: Resume after restore is not manual reinvocation

- **WHEN** the Liveness Provider reattaches a loop supervisor after worker death
- **THEN** the Logical Operation identity SHALL stay the same
- **AND** the resume SHALL NOT count as a new external admission
