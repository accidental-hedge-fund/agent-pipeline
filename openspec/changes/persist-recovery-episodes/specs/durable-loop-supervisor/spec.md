## MODIFIED Requirements

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

Before the supervisor process exits with a verified-complete or authenticated-cancellation run
result, it SHALL persist exactly one
terminal event kind for that exit. Existing stop transitions for genuine human-authority holds SHALL continue to append
`loop_run_stopped` or `loop_run_complete` with their final item accounting. Mechanical exhaustion,
process death, no-progress, capacity, and cycle-cap SHALL persist Cooling or wait evidence. They
SHALL NOT emit a terminal stop event that ends ownership. A process interruption while recovery
remains possible SHALL NOT emit a terminal event. Re-entry SHALL not duplicate an already persisted
terminal event for the same terminal revision.

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
