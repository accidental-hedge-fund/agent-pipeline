# durable-loop-engine Specification

## Purpose
TBD - created by archiving change absorb-goal-loop-core. Update Purpose after archive.
## Requirements
### Requirement: Agent Pipeline SHALL be the sole authoritative durable state engine for loop runs

Agent Pipeline SHALL implement the durable multi-item orchestration engine in-repo and SHALL
NOT invoke, discover, read, or depend on an externally installed goal-loop skill on any
execution path. No second ledger, second run-id namespace, second lock, or second run
directory SHALL be authoritative for a run. The engine SHALL live in a dedicated module and
SHALL NOT be reachable from the per-item advance state machine, which continues to own
exactly one issue at a time.

#### Scenario: A loop run needs no external skill installed

- **WHEN** `pipeline:loop` is invoked on a host with no goal-loop skill present at any
  install root
- **THEN** the run SHALL compile a contract, initialize, lock, and report a run id
- **AND** no install-remediation failure SHALL be produced on any path

#### Scenario: No external engine invocation remains

- **WHEN** the engine's code paths are inspected
- **THEN** they SHALL contain no subprocess invocation of an external goal-loop CLI and no
  read of an external goal-loop install manifest or source file, other than the documented
  legacy-run import path

#### Scenario: The advance state machine cannot drive the engine

- **WHEN** the per-item advance stages are inspected
- **THEN** none SHALL import or call an engine operation that transitions a loop item

---

### Requirement: Contract compilation SHALL normalize discovery into a canonical, dependency-ordered contract

The engine SHALL compile a contract from a discovery input carrying at minimum the target
repository (name and base branch), the selector, and the snapshot of items. Missing required
inputs SHALL be refused as a validation failure. Optional inputs — objective, worktree policy,
done definition, recovery budgets, stop limits, verification commands, and report format —
SHALL take documented defaults when absent. The compiled contract SHALL fix the ordering as
dependency-aware sequential, the maximum active items at one, and the concurrency model as
exclusive-lock single-engine-advance. The contract SHALL record a canonical hash computed
over its content excluding the acting engine and the hash field itself.

#### Scenario: Missing required discovery input is refused

- **WHEN** discovery omits the repository, the selector, or the snapshot of items
- **THEN** compilation SHALL fail as a validation error naming the missing key
- **AND** no run directory SHALL be created

#### Scenario: Optional inputs take documented defaults

- **WHEN** discovery omits the objective, worktree policy, done definition, recovery budgets,
  stop limit, verification block, or report format
- **THEN** the compiled contract SHALL carry the documented default for each omitted key

#### Scenario: Fixed orchestration invariants are not caller-supplied

- **WHEN** discovery attempts to set the ordering, maximum active items, or concurrency model
- **THEN** the compiled contract SHALL still record dependency-aware sequential ordering, a
  maximum of one active item, and exclusive-lock single-engine advance

---

### Requirement: Equivalent inputs SHALL compile to one canonical run identity on either engine

The engine SHALL compute the canonical hash from a single implementation shared by both the
Claude and Codex engines, so equivalent discovery inputs produce byte-identical contracts and
identical canonical hashes regardless of which engine compiles them. The acting engine SHALL
be recorded on the contract but SHALL be excluded from the hashed body. Initializing a run
whose run directory already exists SHALL be refused as a conflict directing the caller to
resume, rather than overwriting the existing run.

#### Scenario: Both engines produce the same canonical hash

- **WHEN** the same discovery input is compiled under the `claude` engine and under the
  `codex` engine
- **THEN** the two contracts SHALL differ only in the recorded engine
- **AND** their canonical hashes SHALL be identical

#### Scenario: Re-initializing an existing run is refused

- **WHEN** initialization targets a run id whose run directory already exists
- **THEN** it SHALL fail as a conflict instructing the caller to resume the run
- **AND** the existing contract, ledger, and logs SHALL be unchanged

---

### Requirement: Dependency ordering SHALL be deterministic and SHALL reject cycles

The engine SHALL order snapshot items so that every item follows the items it depends on,
breaking ties by a documented total order so repeated compilations of the same snapshot
produce an identical sequence. Duplicate item ids SHALL be refused. A dependency cycle SHALL
be refused as a validation failure. A declared dependency on an item outside the snapshot
SHALL be dropped rather than refused, because the snapshot defines the run's world.

#### Scenario: Ordering is dependency-respecting and stable

- **WHEN** a snapshot with declared dependencies is compiled repeatedly
- **THEN** every item SHALL appear after all of its in-snapshot dependencies
- **AND** the resulting order SHALL be identical on every compilation

#### Scenario: A dependency cycle is refused

- **WHEN** the snapshot's dependencies form a cycle
- **THEN** compilation SHALL fail as a validation error naming the cycle
- **AND** no run SHALL be initialized

#### Scenario: Duplicate item ids are refused

- **WHEN** the snapshot contains the same item id twice
- **THEN** compilation SHALL fail as a validation error

#### Scenario: An out-of-snapshot dependency is dropped

- **WHEN** an item declares a dependency on an id not present in the snapshot
- **THEN** compilation SHALL succeed
- **AND** that dependency SHALL not constrain the ordering

---

### Requirement: The ledger SHALL admit only the defined item transition graph

The engine SHALL maintain a per-item state with a defined transition graph and SHALL refuse
any transition not on that graph, naming the current and requested states. The graph SHALL
be: from pending to in-progress, blocked, or abandoned; from in-progress to implemented,
blocked, paused, waiting, or abandoned; from implemented to PR-opened, blocked, or abandoned;
from PR-opened to ready, blocked, or abandoned; from ready to merged, blocked, or abandoned;
from merged to released or deployed; from released to deployed; from blocked to in-progress or
abandoned; from paused to in-progress or abandoned; and from waiting to in-progress or
abandoned. Deployed and abandoned SHALL be terminal with no outgoing transitions. `paused` and
`waiting` SHALL be non-terminal, non-failure holds: entering either SHALL NOT require a theme,
SHALL NOT charge a recovery budget, and SHALL NOT increment the consecutive-blocked count.
Every accepted transition SHALL append a history entry recording the time, the from and to
states, the acting engine, and any supplied theme, evidence, or note.

#### Scenario: Every legal edge is accepted and every illegal edge refused

- **WHEN** each ordered pair of item states is attempted as a transition
- **THEN** exactly the pairs on the defined graph SHALL be accepted
- **AND** every other pair SHALL be refused as a validation error naming both states

#### Scenario: Terminal states have no outgoing transitions

- **WHEN** a transition is attempted out of deployed or abandoned
- **THEN** it SHALL be refused
- **AND** the item's state SHALL be unchanged

#### Scenario: A transition to blocked requires a theme

- **WHEN** a transition to blocked supplies no theme
- **THEN** it SHALL be refused as a validation error
- **AND** when a theme is supplied it SHALL be recorded both on the history entry and as the
  item's current blocked theme

#### Scenario: Paused and waiting are admitted from in-progress and resume in place

- **WHEN** an in-progress item transitions to `paused` or `waiting` and later back to
  `in_progress`
- **THEN** both transitions SHALL be accepted
- **AND** each SHALL append a history entry naming the from and to states and the acting engine

#### Scenario: Entering a hold neither charges budget nor counts a block

- **WHEN** an in-progress item transitions to `paused` or `waiting`
- **THEN** no recovery budget SHALL be decremented
- **AND** the consecutive-blocked count SHALL be unchanged

#### Scenario: History records the acting engine

- **WHEN** a transition is accepted
- **THEN** the history entry SHALL record the engine of the lock holder that performed it

### Requirement: The engine SHALL refuse a transition through an authority gate the contract does not grant

The engine SHALL derive four authority grants — opening a pull request, merging, releasing,
and deploying — from the discovery's explicit grants at compile time, and SHALL map each to the
transition it guards. A gated transition SHALL be authorized only when the compiled contract
grants that gate, or when a matching audited scoped authority amendment (capability
`durable-pause-and-authority`) covers that exact gate for that transition's item; a scoped
amendment SHALL widen authority only for the exact gate and scope it names and SHALL NOT widen
any other gate or item. A transition through a gate that neither a compile-time grant nor a
matching amendment authorizes SHALL be refused with an authority-class failure stating that
broad objectives do not grant gates and that the run must stop and report. No objective text,
selector, or ambient later input SHALL widen a grant — only a compile-time grant or an audited
scoped amendment SHALL do so.

#### Scenario: An ungranted gate refuses the transition

- **WHEN** a transition to a gated state is attempted and neither a compile-time grant nor a
  matching amendment authorizes that gate
- **THEN** it SHALL be refused with an authority-class failure
- **AND** the item's state SHALL be unchanged

#### Scenario: Objective text does not widen a grant

- **WHEN** discovery declares a broad objective but grants no authority and no amendment exists
- **THEN** the compiled contract SHALL record every gate as not granted
- **AND** every gated transition SHALL be refused

#### Scenario: An unknown grant name is refused at compile time

- **WHEN** discovery declares an authority grant outside the four defined names
- **THEN** compilation SHALL fail as a validation error naming the unknown grant

#### Scenario: A matching audited amendment authorizes the gate

- **WHEN** no compile-time grant covers a gate but a matching audited scoped amendment covers
  that gate for the transitioning item, and directly verified evidence is supplied
- **THEN** the gated transition SHALL be authorized

### Requirement: Gated transitions SHALL require directly verified evidence

The engine SHALL require evidence on every gated transition, and SHALL refuse a gated
transition whose evidence is absent or empty with a validation failure stating that directly
verified facts are required rather than an agent's claim. Supplied evidence SHALL be recorded
verbatim on the history entry.

#### Scenario: A gated transition without evidence is refused

- **WHEN** a transition to a gated state supplies no evidence
- **THEN** it SHALL be refused as a validation error demanding directly verified facts
- **AND** the ledger SHALL be unchanged

#### Scenario: Supplied evidence is preserved

- **WHEN** a gated transition supplies evidence and is accepted
- **THEN** the evidence SHALL be recorded on the item's history entry unmodified

---

### Requirement: The engine SHALL enforce the Agent Pipeline execution mandate on item transitions

The engine SHALL require that every item is executed through Agent Pipeline, enforced at
three points with a distinct pipeline-mandate failure class: entering in-progress SHALL
require evidence that the Pipeline preflight passed; reaching ready SHALL require evidence
that the item's Pipeline stage is `pipeline:ready-to-deploy`; and reaching merged SHALL
require evidence that the merge was performed through Pipeline's merge surface together with
the resulting commit SHA. The engine SHALL NOT itself merge, deploy, or release anything.

#### Scenario: Entering in-progress requires a passing preflight

- **WHEN** a transition to in-progress supplies no passing Pipeline preflight evidence
- **THEN** it SHALL be refused with a pipeline-mandate failure

#### Scenario: Resuming a blocked item is equally mandated

- **WHEN** a blocked item transitions back to in-progress
- **THEN** the same passing-preflight evidence SHALL be required

#### Scenario: Ready means the Pipeline stage label

- **WHEN** a transition to ready supplies evidence whose Pipeline stage is not
  `pipeline:ready-to-deploy`
- **THEN** it SHALL be refused with a pipeline-mandate failure

#### Scenario: Merged requires a Pipeline merge and a SHA

- **WHEN** a transition to merged supplies evidence lacking either the Pipeline merge marker
  or the resulting commit SHA
- **THEN** it SHALL be refused with a pipeline-mandate failure

---

### Requirement: The engine SHALL enforce a native autonomous goal-mode evidence mandate

The engine SHALL require fresh evidence that the acting engine's native autonomous goal mode
is currently active for this run before an item may enter in-progress, and before a lock is
acquired over a run that already has an item in-progress. The evidence SHALL name the engine,
the run id, a status, and the time it was checked. The engine SHALL refuse, with a distinct
native-goal-mandate failure class, when the evidence is absent, names a different engine,
names a different run, reports any status other than active, or was checked outside a
documented freshness window of 300 seconds in either direction. A refusal SHALL state the
corrective action: re-run the native bootstrap for that engine and retry with fresh evidence.
Accepted evidence SHALL be recorded on the item history and as the run's last native-goal
check. Read-only operations, and transitions other than entry to in-progress, SHALL NOT be
gated by this mandate.

#### Scenario: Entering in-progress without native-goal evidence is refused

- **WHEN** a transition to in-progress supplies no native-goal evidence
- **THEN** it SHALL be refused with a native-goal-mandate failure naming the corrective action
- **AND** the item's state SHALL be unchanged

#### Scenario: Mismatched engine, run, or status is refused

- **WHEN** the native-goal evidence names a different engine, a different run id, or a status
  other than active
- **THEN** the transition SHALL be refused with a native-goal-mandate failure

#### Scenario: Stale evidence is refused

- **WHEN** the native-goal evidence was checked more than the documented freshness window
  before or after the current time
- **THEN** the transition SHALL be refused with a native-goal-mandate failure

#### Scenario: Resuming a lock over an in-progress run is mandated

- **WHEN** a lock is acquired for a run that has an item in-progress and no valid native-goal
  evidence is supplied
- **THEN** acquisition SHALL be refused before the lock is created
- **AND** when valid evidence is supplied the run's last native-goal check SHALL be updated
  and an event recorded

#### Scenario: Read-only operations are not gated

- **WHEN** status or an audit report is requested for a run whose native goal mode is not
  attested
- **THEN** the operation SHALL succeed

---

### Requirement: The engine SHALL charge recovery budgets and stop terminally on exhaustion

The engine SHALL charge a recovery budget only when an item transitions from blocked back to
in-progress, keyed by that item's typed blocker classification (`DurableBlockerClass`) and falling
back to the default budget when the class has no budget of its own. When the applicable budget is
already exhausted the engine SHALL record a terminal stop naming the exhaustion reason, the
classification, and the item, emit a stop event, and refuse the transition with a stop-class
failure. Otherwise it SHALL decrement the budget and record the charge on the history entry. Once a
run carries a terminal stop, every subsequent transition on any item SHALL be refused with a
stop-class failure naming the stop record.

#### Scenario: Budget is charged only on recovery

- **WHEN** an item transitions from blocked to in-progress
- **THEN** the budget for its blocker classification SHALL decrement by one and the charge SHALL be
  recorded on the history entry
- **AND** no other transition SHALL change any budget

#### Scenario: A failed recovery action charges no budget and does not transition the item

- **WHEN** a recovery is attempted and the attempted actions did not succeed
- **THEN** no budget SHALL be decremented
- **AND** the item SHALL remain `blocked` rather than transitioning to `in_progress`

#### Scenario: Exhausted budget stops the run terminally

- **WHEN** a recovery is attempted with the applicable budget already at zero
- **THEN** the run SHALL be recorded as stopped for recovery exhaustion, naming the classification
  and the item
- **AND** the transition SHALL be refused with a stop-class failure

#### Scenario: A stopped run refuses every further transition

- **WHEN** any item transition is attempted on a run carrying a terminal stop
- **THEN** it SHALL be refused with a stop-class failure naming the stop record

### Requirement: The engine SHALL stop the run when consecutive blocks exceed the configured limit

The engine SHALL count consecutive transitions into blocked and SHALL record a terminal stop,
naming the limit, once that count exceeds the contract's configured maximum. The count SHALL
reset only on a transition representing real forward progress — implemented, PR-opened,
ready, merged, released, or deployed — and SHALL NOT reset merely on entering in-progress.

#### Scenario: Exceeding the limit stops the run

- **WHEN** the number of consecutive blocks exceeds the configured maximum
- **THEN** the run SHALL be recorded as stopped for consecutive blocks, naming the limit
- **AND** a stop event SHALL be emitted

#### Scenario: Forward progress resets the count

- **WHEN** an item transitions to implemented, PR-opened, ready, merged, released, or deployed
- **THEN** the consecutive-blocked count SHALL reset to zero

#### Scenario: Re-entering in-progress does not reset the count

- **WHEN** a blocked item transitions back to in-progress
- **THEN** the consecutive-blocked count SHALL be unchanged

---

### Requirement: The engine SHALL hold a merge barrier until reconciliation observes the merged commit

When an item reaches merged, the engine SHALL record a merge barrier naming the item, the
merged commit SHA, and the time it was set, and SHALL emit a barrier event. While a barrier
is set, the engine SHALL refuse every transition into in-progress with a conflict-class
failure, so no new item starts against a base that has not been observed to contain the
merge. The barrier SHALL be cleared only by a reconciliation whose observed truth reports a
base commit and includes the barrier's merged SHA among the merged commits, and clearing
SHALL emit an event carrying the barrier being cleared.

#### Scenario: A merge sets the barrier

- **WHEN** an item transitions to merged
- **THEN** the ledger SHALL record a barrier naming the item and the merged commit SHA
- **AND** a barrier event SHALL be emitted

#### Scenario: The barrier blocks starting the next item

- **WHEN** a transition into in-progress is attempted while a barrier is set
- **THEN** it SHALL be refused with a conflict-class failure naming the barrier

#### Scenario: Reconciliation clears the barrier only on observed evidence

- **WHEN** reconciliation reports a base commit and lists the barrier's merged SHA among the
  merged commits
- **THEN** the barrier SHALL be cleared and an event emitted carrying the cleared barrier
- **AND** when either the base commit or the merged SHA is absent the barrier SHALL remain set

---

### Requirement: Reconciliation SHALL record caller-observed truth and report drift without resolving it

The engine SHALL accept an observed-truth document supplied by the caller and SHALL NOT read
GitHub or any other external system itself. It SHALL compare each ledger item against the
observed state for that item, report every mismatch as the item id with its ledger state and
its observed state, and SHALL NOT modify item states to match the observation. Items absent
from the observation and observed items absent from the ledger SHALL be ignored.
Reconciliation SHALL record the observation with a monotonically increasing sequence number
and the time, emit an event, and succeed even when mismatches are reported.

#### Scenario: Drift is reported, not silently applied

- **WHEN** the observed state of an item differs from its ledger state
- **THEN** the mismatch SHALL be reported with the item id, the ledger state, and the observed
  state
- **AND** the item's ledger state SHALL be unchanged

#### Scenario: Reconciliation reads no external system

- **WHEN** reconciliation runs through the injected seams
- **THEN** zero GitHub calls and zero subprocess invocations SHALL have been recorded

#### Scenario: Unmatched items are ignored

- **WHEN** the observation omits a ledger item, or names an item the ledger does not have
- **THEN** no mismatch SHALL be reported for it and reconciliation SHALL succeed

#### Scenario: Reconciliations are sequenced

- **WHEN** reconciliation runs repeatedly
- **THEN** each SHALL record a sequence number one greater than the previous

---

### Requirement: The engine SHALL expose a stable failure taxonomy

The engine SHALL classify every refusal into exactly one documented class — validation, lock,
authority, stop, conflict, pipeline mandate, or native-goal mandate — and SHALL surface that
class distinctly to callers so a failure is never misdiagnosed as another. Every refusal
SHALL leave the run's durable state unchanged.

#### Scenario: Each refusal carries its class

- **WHEN** a refusal of each documented kind is produced
- **THEN** each SHALL report its own class and a message naming the specific cause

#### Scenario: A refusal is side-effect free

- **WHEN** any refusal path is exercised through the injected seams
- **THEN** the ledger, event log, decision log, and lock SHALL be byte-identical to their
  pre-attempt content, except where a requirement explicitly mandates recording a terminal
  stop

