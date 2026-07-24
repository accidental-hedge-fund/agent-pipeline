## ADDED Requirements

### Requirement: The run SHALL record every parallelize-or-serialize decision in a durable run-scoped ledger

The integrated `pipeline:loop` run SHALL maintain a single durable, run-scoped **parallelization
decision ledger** that records every pairwise parallelize-or-serialize decision made over the life of
the run. Each ledger entry SHALL name the two items it concerns, its disposition (`parallelized` or
`serialized`), and exactly one structured reason drawn from the independent-set scheduler's closed
reason set (admitted/disjoint, dependency path, conflict edge, unknown ownership, active merge barrier,
unresolved reconciliation drift, or budget truncation). The ledger SHALL accumulate the scheduler's
already-emitted per-pass planning records without re-deciding any pairing, and its reasons SHALL be a
subset of that closed set so no new decision vocabulary is introduced. The ledger SHALL be
reconstructable from durable run state alone, and producing or reading it SHALL mutate no external
system and start, serialize, or merge no item.

#### Scenario: Every evaluated pair yields one ledger entry

- **WHEN** a run evaluates a frontier containing both disjoint and conflicting item pairs
- **THEN** the ledger SHALL contain one entry per evaluated pair
- **AND** each entry SHALL carry a `parallelized`/`serialized` disposition and exactly one structured
  reason

#### Scenario: A serialized pair names its structured reason

- **WHEN** a pair is serialized because the two items conflict on a co-owned shared surface
- **THEN** its ledger entry SHALL record the `serialized` disposition and the conflict-edge reason
  naming that surface

#### Scenario: The ledger reasons stay within the scheduler's closed set

- **WHEN** any decision is appended to the ledger
- **THEN** its structured reason SHALL be a member of the independent-set scheduler's closed reason set

#### Scenario: The ledger reconstructs from durable state

- **WHEN** the run's parallelization history is audited from recorded run state alone
- **THEN** every parallelize-or-serialize decision SHALL be recoverable from the ledger without any
  in-memory or narrative source

### Requirement: The run SHALL never execute an unproven pair concurrently

The run SHALL NOT hold two items simultaneously `in_progress` unless the ownership evaluator and the
independent-set scheduler have proven that exact pair `disjoint` and recorded a `parallelized` decision
for it. Any pair that is not proven disjoint — including a pair with a dependency path between the
items, an explicit or derived ownership conflict edge, unknown ownership on either item, a shared active
merge barrier, or unresolved reconciliation drift — SHALL be serialized. Unknown overlap SHALL always
collapse to serial: no pair SHALL run concurrently on the strength of missing, ambiguous, or unverified
independence information. With no `concurrency` run policy the run SHALL serialize every pair and its
observable behavior SHALL be identical to the existing single-active-item behavior.

#### Scenario: A proven-disjoint pair runs concurrently

- **WHEN** two eligible items are proven `disjoint` and the `concurrency` budget is at least two
- **THEN** the run MAY hold both items `in_progress` at once

#### Scenario: An unknown-ownership pair is serialized

- **WHEN** either item of an eligible pair carries no ownership declaration or an uncovered comparison
  surface
- **THEN** the run SHALL NOT hold both items `in_progress` at once

#### Scenario: A conflicting or dependency-linked pair is serialized

- **WHEN** two eligible items evaluate `conflict`, or one declares a dependency on the other
- **THEN** the run SHALL run them serially

#### Scenario: No policy means fully serial

- **WHEN** the run carries no `concurrency` policy
- **THEN** the run SHALL hold at most one item `in_progress`
- **AND** its observable behavior SHALL match the existing serialized single-active-item behavior

### Requirement: Merge-class operations SHALL remain globally serialized for the whole run

The run SHALL keep merge-class operations — the merge surface, base refresh, and post-merge
reconciliation — globally serialized for its entire life, even while proven-independent items execute
concurrently. No item SHALL be admitted into `in_progress` while a merge barrier is set, and two
merge-class operations SHALL never run at the same time. Concurrent implementation and review work SHALL
NOT weaken this barrier: each item SHALL still pass its own review and pre-merge gates, and the run SHALL
still stop at `pipeline:ready-to-deploy`. Nothing in this capability SHALL authorize a merge, relax a
review gate, or advance an item past `pipeline:ready-to-deploy`.

#### Scenario: An active merge barrier blocks all new starts

- **WHEN** a merge barrier is set and eligible items remain
- **THEN** the run SHALL admit no item into `in_progress` until the barrier clears

#### Scenario: Merge-class operations do not overlap

- **WHEN** a merge, base refresh, or post-merge reconciliation is in progress
- **THEN** the run SHALL NOT start a second merge-class operation concurrently

#### Scenario: Concurrency grants no merge authority

- **WHEN** a proven-independent set has completed its concurrent implementation and review work
- **THEN** each item SHALL still pass its own review and pre-merge gates
- **AND** the run SHALL still stop at `pipeline:ready-to-deploy`

### Requirement: Mid-run changed-file overlap SHALL park the affected items and require reconciliation

The run SHALL park any concurrently-executing items that are observed to have actually changed
**overlapping files** their declared ownership did not predict, and SHALL record a durable replan
request naming the overlapping file and the affected items, rather than racing either item into
concurrent merge preparation. Parking SHALL be scoped to the items whose changed files actually
overlap; an unaffected item's independence evidence SHALL be preserved. Parking SHALL perform no
external mutation — no merge, push, label write, or branch/worktree deletion — and a subsequent
scheduling pass SHALL re-derive the schedule deterministically from the corrected inputs.

#### Scenario: Actual overlap parks the affected pair

- **WHEN** two concurrently-executing items are observed to have changed the same file that their
  declarations did not mark as shared
- **THEN** the run SHALL park both affected items and record a replan request naming the file
- **AND** neither parked item SHALL proceed into concurrent merge preparation

#### Scenario: Parking is scoped and evidence-preserving

- **WHEN** one pair is parked for changed-file overlap while a third item's changes overlap neither
- **THEN** the third item's independence evidence SHALL be preserved

#### Scenario: Parking mutates no external system

- **WHEN** the run parks items for changed-file overlap
- **THEN** it SHALL record the replan request without merging, pushing, or deleting any branch or
  worktree

### Requirement: Every run action and decision SHALL be durable, reconstructable evidence

The run SHALL make every action, conflict detection, and scheduling decision reconstructable from
durable evidence alone — the parallelization decision ledger, the per-item ownership and surface-
normalization records, the reconciliation drift and changed-file-overlap records, and each item's
action evidence. No parallelize-or-serialize decision, conflict detection, or item action SHALL be
provable only from an in-memory value or a narrative summary; a reviewer SHALL be able to reconstruct
the run's full parallelization history and each item's terminal outcome from recorded run state.

#### Scenario: A conflict detection is reconstructable

- **WHEN** the run serializes a pair because of a detected conflict
- **THEN** both the normalized surface sets and the structured conflict reason SHALL be recoverable
  from durable evidence

#### Scenario: The full run history reconstructs from evidence

- **WHEN** a reviewer audits a completed conflict-aware parallel run
- **THEN** every action, conflict detection, and scheduling decision SHALL be derivable from durable
  run state without a narrative summary

### Requirement: The composed guarantee SHALL be proven end-to-end by the parallel-conflict pilot

The run-level guarantees of this capability SHALL be proven end-to-end by the parallel-conflict pilot
(`durable-run-parallel-conflict-pilot`, #531), designated as this capability's acceptance vehicle. The
pilot's hermetic composition simulation SHALL exercise the full sequence — disjoint concurrency with
independent per-item worktrees and evidence, serialization of a conflicting item with a structured
reason, mid-run changed-file-overlap park/replan, and globally-serialized merge-class integration —
with zero real network, git, or subprocess calls and every assertion proven to bite; and the captured
live-pilot evidence bundle SHALL demonstrate the same composed guarantee against a live GitHub
repository, referencing the run-scoped parallelization decision ledger.

#### Scenario: The hermetic simulation exercises the composed sequence

- **WHEN** the parallel-conflict pilot's composition simulation runs in CI
- **THEN** it SHALL drive disjoint concurrency, serialized conflict, changed-file-overlap park/replan,
  and serialized merge-class integration with zero real network, git, or subprocess calls
- **AND** every assertion SHALL fail when its corresponding composed behavior is defeated

#### Scenario: The live-pilot evidence bundle demonstrates the guarantee

- **WHEN** the real live parallel-conflict pilot is executed
- **THEN** its captured evidence bundle SHALL demonstrate the composed guarantee and reference the
  run-scoped parallelization decision ledger
