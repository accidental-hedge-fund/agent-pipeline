# durable-run-parallel-conflict-pilot Specification

## Purpose
TBD - created by archiving change durable-run-parallel-conflict-pilot. Update Purpose after archive.
## Requirements
### Requirement: The pilot SHALL drive a bounded conflict-aware parallel run of a disjoint pair plus a conflicting item

The conflict-aware parallel pilot SHALL define a reproducible run of exactly three items — item **A**,
item **B**, and item **C** — under a `concurrency` run policy whose budget is greater than one, where
A and B carry ownership declarations the pairwise evaluator proves `disjoint` and C carries a
declaration that conflicts with an admitted item (a co-owned shared surface, an overlapping exclusive
source glob, or an explicit `conflicts_with` edge). The pilot SHALL exercise this run through the
shipped composed runtime — the independence scheduler, the pairwise ownership evaluator, the
supervisor cycle, reconciliation, and the evidence projection — and SHALL NOT introduce a second
ledger, lock, run directory, or a new external mutation path.

#### Scenario: The fixture composes a disjoint pair and a conflicting item under a concurrency budget

- **WHEN** the pilot run is compiled with items A, B disjoint and item C conflicting under a
  `concurrency` budget greater than one
- **THEN** the run SHALL be driven through the shipped scheduler and supervisor
- **AND** no second ledger, lock, or run-id namespace SHALL be created

#### Scenario: The pilot uses the shipped runtime, not a parallel one

- **WHEN** the pilot drives the run
- **THEN** every durable write SHALL be issued through the engine into the single authoritative run
  directory

---

### Requirement: The pilot SHALL start the disjoint pair concurrently in separate worktrees with independent evidence

The pilot SHALL prove that items A and B are admitted into the concurrent set together — up to the
configured budget and only because the pairwise evaluator returned `disjoint` — with each admitted
item assigned its **own separate managed worktree**. The pilot SHALL prove that each item retains
independent Pipeline evidence: one member's ledger history, action-evidence, and worktree identity
SHALL NOT appear in the other's, and a failure of one member SHALL NOT re-drive or invalidate the
other's independence evidence.

#### Scenario: A proven-disjoint pair is admitted together

- **WHEN** items A and B evaluate `disjoint` and the concurrency budget is at least two
- **THEN** the scheduler SHALL admit both A and B into the concurrent set

#### Scenario: Each concurrent item runs in its own managed worktree

- **WHEN** A and B are admitted into the concurrent set
- **THEN** each item SHALL be assigned its own separate managed worktree
- **AND** the two worktree identities SHALL be distinct

#### Scenario: Independent evidence does not bleed across members

- **WHEN** A and B run concurrently
- **THEN** each item's ledger history, action-evidence, and worktree identity SHALL be recorded
  independently
- **AND** a failure of one member SHALL NOT re-drive or invalidate the other member's evidence

---

### Requirement: The pilot SHALL serialize the conflicting item with a durable structured reason

The pilot SHALL prove that item C is excluded from the concurrent set and left to run only after the
active items drain, and that the scheduler's durable planning record carries, for item C, exactly one
structured conflict reason drawn from the closed set — co-owned shared surface, overlapping exclusive
source glob, explicit `conflicts_with` edge, or unknown ownership — together with the admitted item C
conflicts with. Producing this record SHALL NOT start, merge, or serialize any item through an
external system.

#### Scenario: A conflicting candidate is serialized

- **WHEN** item C evaluates `conflict` against an admitted item
- **THEN** the scheduler SHALL exclude C from the concurrent set
- **AND** C SHALL run only after the active items drain

#### Scenario: The serialized item's record names one structured reason and the item it conflicts with

- **WHEN** item C is serialized for a conflict
- **THEN** C's durable planning record entry SHALL carry exactly one structured conflict reason
- **AND** it SHALL name the admitted item C conflicts with

#### Scenario: The planning record schedules nothing on its own

- **WHEN** the planning record that serializes C is produced
- **THEN** no item state SHALL change and no external system SHALL be mutated as a result

---

### Requirement: The pilot SHALL park and replan on mid-run changed-file overlap rather than permit concurrent merge preparation

The pilot SHALL prove that when concurrently-run items A and B are observed to have actually changed
an **overlapping file** that their declared ownership did not mark as shared, the scheduler **parks**
the affected pair and records a durable **replan request** naming the overlapping file — rather than
permitting either affected item to proceed into concurrent merge preparation. Parking SHALL be scoped
to the affected items: an unaffected item's independence evidence in the same pass SHALL be preserved.
Parking SHALL perform no external mutation — no merge, push, label write, or branch/worktree deletion.

#### Scenario: Observed overlap parks the affected pair and requests a replan

- **WHEN** concurrently-run A and B are observed to have changed the same file that their declarations
  did not mark as shared
- **THEN** the scheduler SHALL park both affected items
- **AND** it SHALL record a durable replan request naming the overlapping file

#### Scenario: A parked item does not prepare a merge concurrently

- **WHEN** A and B are parked for a changed-file overlap
- **THEN** neither parked item SHALL proceed into concurrent merge preparation

#### Scenario: Parking is scoped and mutates no external system

- **WHEN** the affected pair is parked while an unaffected item's changes do not overlap either
- **THEN** the unaffected item's independence evidence SHALL be preserved
- **AND** parking SHALL record the replan request without merging, pushing, writing a label, or
  deleting any branch or worktree

---

### Requirement: The pilot SHALL keep merge, base refresh, and final reconciliation globally serialized after concurrent work

The pilot SHALL prove that, after the concurrent implementation and review work on the disjoint pair,
the merge-class operations — the merge surface, base refresh, and final reconciliation — remain
globally serialized: no item SHALL be admitted into `in_progress` while a merge barrier is set, and no
two merge-class operations SHALL run at the same time. The pilot SHALL prove that concurrency grants no
merge authority: each admitted item SHALL still pass its own review and pre-merge gates, and the run
SHALL still stop at `pipeline:ready-to-deploy`.

#### Scenario: An active barrier blocks all new starts during integration

- **WHEN** a merge barrier is set after the concurrent work and eligible items remain
- **THEN** the scheduler SHALL admit no item into `in_progress` until the barrier is cleared

#### Scenario: Merge-class operations do not overlap

- **WHEN** a merge, base refresh, or final reconciliation is in progress
- **THEN** the scheduler SHALL NOT start a second merge-class operation concurrently

#### Scenario: Concurrency grants no merge authority

- **WHEN** the concurrent set has completed its implementation and review work
- **THEN** each admitted item SHALL still pass its own review and pre-merge gates
- **AND** the run SHALL still stop at `pipeline:ready-to-deploy`

---

### Requirement: The pilot SHALL emit a derived evidence bundle covering every exercised behavior

The pilot SHALL emit exactly one evidence bundle for the run that references the concrete recorded
durable artifacts proving each exercised behavior: the observed concurrency (which items ran
together), the pairwise ownership decisions and their structured reasons, per-item worktree identity,
the changed-file-overlap conflict detection together with its replan request, and each item's terminal
outcome. The bundle SHALL be derived from recorded run state — the durable planning record, ledger,
events, and action-evidence — and SHALL NOT be a free-form narrative summary; each of the five
exercised behaviors (disjoint concurrency with independent evidence, serialized conflict,
changed-file-overlap park/replan, serialized merge-class integration, evidence reporting) SHALL be
locatable within it.

#### Scenario: The bundle references recorded artifacts, not prose

- **WHEN** the pilot emits its evidence bundle
- **THEN** the bundle SHALL reference the observed concurrency, the pairwise ownership decisions and
  reasons, per-item worktree identity, the changed-file-overlap detection and replan request, and each
  item's terminal outcome, drawn from recorded run state

#### Scenario: Each exercised behavior is locatable in the bundle

- **WHEN** a reviewer reads the evidence bundle
- **THEN** each of the five exercised behaviors SHALL be locatable within it

---

### Requirement: The pilot SHALL be verified hermetically in CI through injected seams

The pilot SHALL include a composition simulation that drives the entire
disjoint-concurrency → serialized-conflict → changed-file-overlap-park → serialized-merge sequence
through the existing injected scheduler, pairwise-ownership-evaluator, supervisor, and
reconciliation-observation seams, performing zero real network, git, and subprocess calls. Every
assertion the simulation makes about a composed behavior SHALL be proven to bite — defeating the
behavior SHALL cause the corresponding assertion to fail.

#### Scenario: The simulation runs end to end with no real I/O

- **WHEN** the composition simulation runs from `core/` with no outbound network access
- **THEN** it SHALL drive the run to its expected terminal condition through injected fakes
- **AND** zero real network, git, and subprocess calls SHALL be recorded

#### Scenario: Each composition assertion bites

- **WHEN** a composed behavior under test (concurrent admission, conflict serialization,
  changed-file-overlap parking, or the serialized merge barrier) is defeated
- **THEN** the corresponding simulation assertion SHALL fail

---

### Requirement: The live pilot SHALL be documented as a runbook and executed with a captured evidence bundle

The pilot SHALL provide an operator-facing runbook documenting the exact steps to run the real
conflict-aware parallel pilot against a GitHub repository — including how the disjoint pair is chosen,
how a mid-run changed-file overlap is induced, and how a human performs each merge (the pipeline never
merges) — and an evidence-bundle artifact contract mapping each of the five exercised behaviors to the
concrete recorded artifacts the live run must capture. The real live conflict-aware parallel pilot
SHALL be executed per the runbook and its captured evidence bundle SHALL demonstrate all five
behaviors and be linked from issue #531.

#### Scenario: The runbook pins the human merges and the evidence contract

- **WHEN** an operator follows the live-pilot runbook
- **THEN** the runbook SHALL specify that a human performs each merge and that the pilot only observes
  the merge surface
- **AND** the runbook SHALL enumerate the evidence-bundle artifacts required for each of the five
  exercised behaviors

#### Scenario: The executed live pilot produces a linked evidence bundle

- **WHEN** the real conflict-aware parallel live pilot has been executed
- **THEN** its captured evidence bundle SHALL demonstrate disjoint concurrency with independent
  evidence, serialized conflict, changed-file-overlap park/replan, serialized merge-class integration,
  and evidence reporting
- **AND** the bundle SHALL be linked from issue #531

