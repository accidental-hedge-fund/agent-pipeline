## ADDED Requirements

### Requirement: The scheduler SHALL serialize by default and admit concurrency only under an explicit run policy with proven independence

The scheduler SHALL treat serial execution as the default and SHALL admit more than one item into
`in_progress` at a time only when the loop contract carries a `concurrency` run policy whose budget
is greater than one **and** the additional items are proven independent by every independence check
this capability defines. When no `concurrency` policy is present, or its budget is one, the scheduler
SHALL select exactly one item and the run's observable behavior SHALL be identical to the existing
serialized single-active-item behavior. A budget greater than one SHALL never by itself cause a
second item to start — proof of independence is always required. The scheduler SHALL be a pure,
deterministic decision that, in unit tests, runs with no real network, git, or subprocess calls.

#### Scenario: Absent policy schedules exactly one item

- **WHEN** the contract carries no `concurrency` run policy and several items are eligible
- **THEN** the scheduler SHALL select exactly one item
- **AND** the selection SHALL match the existing serialized behavior

#### Scenario: A budget above one still requires proof

- **WHEN** the `concurrency` budget is greater than one but no additional eligible item is proven
  independent of the first
- **THEN** the scheduler SHALL select exactly one item

#### Scenario: Concurrency is admitted only with a policy and proof

- **WHEN** the `concurrency` budget is greater than one and additional eligible items are each
  proven independent
- **THEN** the scheduler SHALL admit them up to the budget

### Requirement: The scheduler SHALL select a deterministic, budget-bounded independent set

The scheduler SHALL produce, from the eligible-item frontier, a **selected set** whose members are
**pairwise independent** and whose size never exceeds the configured concurrency budget. Membership
SHALL be admitted only when, for every pair of admitted items, all of the following hold: there is no
dependency path between them (neither in-snapshot `depends_on` nor `external_depends_on`, and neither
is gated on a `blocked` dependency); the ownership conflict evaluator returns `disjoint` for the pair;
they share no active merge barrier; and neither carries unresolved live reconciliation drift. The
selected set and its member order SHALL be a deterministic function of the contract, ledger, ownership
verdicts, external-dependency statuses, reconciliation drift, and merge-barrier state, so identical
inputs always yield an identical ordered set. Truncation to the budget SHALL follow the same
documented total order.

#### Scenario: The set never exceeds the budget

- **WHEN** more independent items are eligible than the concurrency budget allows
- **THEN** the scheduler SHALL admit at most the budgeted number of items
- **AND** the admitted subset SHALL be chosen by the documented total order

#### Scenario: Selection is deterministic

- **WHEN** the same contract, ledger, ownership verdicts, external statuses, drift, and barrier state
  are scheduled more than once
- **THEN** each pass SHALL return an identical ordered selected set

#### Scenario: An independent triple is admitted together

- **WHEN** three eligible items are pairwise `disjoint`, dependency-free, drift-free, and unbarriered,
  and the budget is at least three
- **THEN** the scheduler SHALL admit all three

### Requirement: The scheduler SHALL serialize any item that is not proven independent

The scheduler SHALL exclude from the concurrent set — leaving it to run only after the active items
drain — any eligible item that, against any already-admitted item, has a dependency path, an explicit
or derived ownership conflict edge, unknown ownership, a shared active merge barrier, or unresolved
live reconciliation drift. Unknown ownership SHALL be treated as unsafe: an item whose ownership is
undeclared or whose comparison surface is uncovered SHALL NOT be admitted alongside another item. No
item SHALL be admitted on the strength of missing, ambiguous, or unverified independence information —
the conservative default is to serialize.

#### Scenario: A dependency path serializes the dependent

- **WHEN** one eligible item declares a dependency (in-snapshot or external) on another candidate
- **THEN** the two items SHALL NOT be admitted into the same concurrent set

#### Scenario: A conflict pair is serialized

- **WHEN** two eligible items evaluate `conflict` under the ownership evaluator
- **THEN** at most one of them SHALL be admitted into the concurrent set

#### Scenario: Unknown ownership is serialized

- **WHEN** an eligible item carries no ownership declaration or an uncovered comparison surface
- **THEN** it SHALL NOT be admitted alongside another item

#### Scenario: Unresolved drift serializes a candidate

- **WHEN** an eligible item carries an unresolved reconciliation drift record
- **THEN** it SHALL NOT be admitted into the concurrent set until the drift is resolved

### Requirement: The scheduler SHALL record an allow/deny rationale for every candidate

The scheduler SHALL emit a **durable planning record** that lists every eligible candidate together
with its disposition — **admitted** or **serialized/denied** — and exactly one structured reason for
that disposition, drawn from a closed set: admitted, dependency path, conflict edge, unknown
ownership, active merge barrier, unresolved drift, or budget truncation. The record SHALL be an audit
artifact only: producing it SHALL NOT start, merge, or serialize any item, and SHALL NOT mutate any
external system. The record SHALL be a deterministic function of the same inputs as the selected set.

#### Scenario: Every candidate is accounted for with one reason

- **WHEN** a scheduling pass evaluates a frontier of eligible candidates
- **THEN** the planning record SHALL contain one entry per candidate
- **AND** each entry SHALL carry exactly one structured disposition reason

#### Scenario: A denied candidate names its structured reason

- **WHEN** a candidate is serialized because it conflicts with an admitted item
- **THEN** its record entry SHALL name the conflict-edge reason and the item it conflicts with

#### Scenario: The record schedules nothing on its own

- **WHEN** the planning record is produced
- **THEN** no item state SHALL change and no external system SHALL be mutated as a result

### Requirement: Merge, base refresh, and final reconciliation SHALL be globally serialized

The scheduler SHALL keep merge-class operations — the merge surface, base refresh, and final
reconciliation — globally serialized even while independent items run concurrently. It SHALL admit no
item into `in_progress` while a merge barrier is set, honoring the existing `durable-loop-engine`
merge barrier without weakening it, and SHALL never schedule two merge-class operations at the same
time. Nothing in this capability SHALL authorize a merge, relax a review gate, or advance an item past
`pipeline:ready-to-deploy`.

#### Scenario: An active barrier blocks all new starts

- **WHEN** a merge barrier is set and eligible items remain
- **THEN** the scheduler SHALL admit no item into `in_progress` until the barrier is cleared

#### Scenario: Merge-class operations do not overlap

- **WHEN** a merge, base refresh, or final reconciliation is in progress
- **THEN** the scheduler SHALL NOT start a second merge-class operation concurrently

#### Scenario: The scheduler grants no merge authority

- **WHEN** any concurrent set is selected
- **THEN** each admitted item SHALL still pass its own review and pre-merge gates
- **AND** the pipeline SHALL still stop at `pipeline:ready-to-deploy`

### Requirement: Observed changed-file overlap SHALL park the affected items and record a replan request

The scheduler SHALL **park** the affected items and record a **replan request** when concurrently-run
items are observed to have actually changed **overlapping files** that their declared ownership did
not predict, rather than proceeding as though they were independent. Parking SHALL be scoped to
the items whose changed files actually overlap; the independence evidence of unaffected items in the
same pass SHALL be preserved. The replan request SHALL be a durable record naming the overlapping
files and the affected items so a subsequent pass re-derives the schedule from corrected inputs.
Parking SHALL perform no external mutation — no merge, push, label write, or branch/worktree deletion.

#### Scenario: Actual overlap parks the affected pair

- **WHEN** two concurrently-run items are observed to have changed the same file that their
  declarations did not mark as shared
- **THEN** the scheduler SHALL park both affected items and record a replan request naming the file

#### Scenario: Unaffected evidence survives a parking event

- **WHEN** one pair is parked for changed-file overlap while a third item's changes do not overlap
  either
- **THEN** the third item's independence evidence SHALL be preserved

#### Scenario: Parking mutates no external system

- **WHEN** the scheduler parks items for changed-file overlap
- **THEN** it SHALL record the replan request without merging, pushing, or deleting any branch or
  worktree

### Requirement: A blocked or failed member SHALL not duplicate work or invalidate independent evidence

The scheduler SHALL be idempotent across passes: a blocked or failed member of a concurrent set SHALL
NOT cause already-attempted work to be re-driven and SHALL NOT invalidate the independence evidence of
its unaffected siblings. Each admitted item SHALL run in its own **separate managed worktree**, so one
member's failure leaves the others' worktrees and durable state untouched. The next scheduling pass
SHALL recompute the selected set deterministically from durable state, so a failure produces no
duplicate external action and no lost proof for independent items.

#### Scenario: A failed member does not re-drive its siblings

- **WHEN** one member of a concurrent set becomes blocked or failed
- **THEN** the other members' in-progress work SHALL NOT be restarted or duplicated
- **AND** their independence evidence SHALL remain valid

#### Scenario: Items run in separate managed worktrees

- **WHEN** a concurrent set of two or more items is admitted
- **THEN** each item SHALL be assigned its own managed worktree

#### Scenario: The next pass recomputes deterministically

- **WHEN** a scheduling pass runs after a member failed
- **THEN** the recomputed selected set SHALL be a deterministic function of the durable state
- **AND** no external action already performed SHALL be repeated
