# durable-run-dependency-integrity Specification

## Purpose
TBD - created by archiving change durable-run-dependency-integrity. Update Purpose after archive.

## Requirements

### Requirement: The engine SHALL verify external dependencies against live truth before a dependent item starts

The engine SHALL treat each id in an item's `external_depends_on` list as a prerequisite whose
satisfaction is resolved from **live external truth** through the engine-owned observation seam
(the `durable-run-reconciliation` seam), never from a caller-supplied claim. It SHALL classify each
external dependency into exactly one of three states: **satisfied** when the dependency's issue is
observed closed-as-completed or its linked pull request is observed merged; **unsatisfiable** when the
dependency's issue is observed closed-as-not-planned; and **pending** when the dependency's issue is
observed open. An item SHALL NOT be eligible to start while any of its external dependencies is in a
state other than **satisfied**. Verification SHALL perform no external mutation and, in unit tests,
SHALL run entirely through injected fakes with no real network, git, or subprocess calls.

#### Scenario: A pending external dependency blocks the dependent item

- **WHEN** an item's external dependency issue is observed open
- **THEN** that item SHALL NOT be eligible to start
- **AND** the run SHALL NOT drive that item

#### Scenario: A satisfied external dependency releases the dependent item

- **WHEN** an item's every external dependency is observed closed-as-completed or its linked PR merged
- **THEN** that item SHALL become eligible to start, subject to the single-active-item and
  in-snapshot dependency ordering invariants

#### Scenario: External verification reads live truth, not a caller claim

- **WHEN** external-dependency satisfaction is resolved
- **THEN** it SHALL be derived from the engine-owned live observation seam
- **AND** a unit test driving it with fakes SHALL record zero real network, git, and subprocess calls

### Requirement: The engine SHALL propagate a terminal skip to the dependents of a non-successful dependency

The engine SHALL propagate a transition to `skipped` to the transitive `pending` or `blocked`
dependents of any dependency that reaches a terminal non-success state — an in-snapshot dependency
that is `abandoned` or `skipped`, or an external dependency observed **unsatisfiable** — because
those dependents can never satisfy their declared prerequisites. Each propagated transition SHALL
append a history entry naming the causing dependency and SHALL emit an event. An item that retains an
alternative, still-satisfiable path to all of its dependencies SHALL NOT be skipped. A `skipped` item
SHALL count as terminal for run completion, exactly as `abandoned` does.

#### Scenario: An abandoned dependency skips its dependents

- **WHEN** an in-snapshot dependency becomes `abandoned` and a `pending` item depends on it
- **THEN** the dependent SHALL transition to `skipped` rather than remain `pending`
- **AND** its history entry SHALL name the abandoned dependency and an event SHALL be emitted

#### Scenario: An unsatisfiable external dependency skips its dependents

- **WHEN** an item's external dependency issue is observed closed-as-not-planned
- **THEN** that item SHALL transition to `skipped`
- **AND** its history entry SHALL name the unsatisfiable external dependency

#### Scenario: A dependent with an alternative satisfiable path is not skipped

- **WHEN** an item's dependency terminates non-successfully but the item has another declared
  dependency path that is still satisfiable
- **THEN** the item SHALL NOT be skipped

#### Scenario: Skipped counts as terminal for completion

- **WHEN** every item is in a done, `abandoned`, or `skipped` state
- **THEN** the run SHALL be reported complete

### Requirement: The engine SHALL report a typed dependency deadlock instead of spinning

The engine SHALL record a terminal stop whose reason is `dependency_deadlock` when the run's frontier
is structurally unrunnable — no item is `in_progress`, no item is eligible to start, and at least one
non-terminal item remains gated on a **pending** or **unsatisfiable** dependency — rather than allow
the run to spin no-progress cycles into the generic `supervisor_no_progress` watchdog.
Deadlock detection SHALL run **after** skip propagation, so purely in-run abandon/skip chains have
already resolved to `skipped`. The stop record SHALL carry a structured deadlock chain that, for each
stuck item, names the dependency it waits on, whether that dependency is in-run or external, and that
dependency's observed state. The engine SHALL emit a run-stopped event for the deadlock.

#### Scenario: An externally-gated frontier stops with a dependency deadlock

- **WHEN** the only remaining non-terminal items are gated on pending or unsatisfiable dependencies,
  no item is `in_progress`, and none is eligible
- **THEN** the run SHALL stop with reason `dependency_deadlock`
- **AND** the stop's deadlock chain SHALL name each stuck item, its awaited dependency, whether that
  dependency is in-run or external, and the dependency's observed state

#### Scenario: A dependency deadlock is distinct from no-progress

- **WHEN** a run is deadlocked on dependencies
- **THEN** it SHALL stop with `dependency_deadlock`
- **AND** it SHALL NOT be reported as `supervisor_no_progress`

### Requirement: Dependency-independent items SHALL continue while others are abandoned, skipped, or externally gated

The engine SHALL treat an `abandoned`, `skipped`, or non-`satisfied` externally-gated dependency the
same as a `blocked` dependency when computing item eligibility, and SHALL allow every
dependency-independent item to run to completion regardless of the fate of items it does not depend
on. The `dependency_deadlock` stop SHALL fire only when **no** dependency-independent item can run.
This composes with — and SHALL NOT weaken — the `durable-blocker-classification` requirement that
independent eligible items continue past a non-run-fatal block, the single-active-item invariant, and
the merge barrier.

#### Scenario: An independent item completes before any deadlock is reported

- **WHEN** one item is `abandoned`, `skipped`, or externally gated while another item depends on none
  of the stuck items
- **THEN** the independent item SHALL be driven to completion
- **AND** no `dependency_deadlock` SHALL be reported while a dependency-independent item can still run

#### Scenario: The deadlock stop respects existing invariants

- **WHEN** dependency-independent items continue past a stuck item
- **THEN** at most one item SHALL be active at a time
- **AND** the merge barrier SHALL NOT be bypassed

### Requirement: Train merge mode SHALL not treat ready-to-deploy as dependency satisfaction

When an integrated train runs with `--merge`, a same-train prerequisite that has only reached `pipeline:ready-to-deploy` SHALL NOT satisfy a dependent's in-train dependency. The dependent SHALL become eligible only after the train records verified integration evidence for the prerequisite: the linked pull request is merged through the Pipeline merge surface and the merge-result commit is contained in a freshly fetched configured base.

#### Scenario: Ready prerequisite does not release a dependent in merge train

- **WHEN** prerequisite A is at `pipeline:ready-to-deploy` with an open PR during a merge train that also contains dependent B
- **THEN** B SHALL NOT start
- **AND** the train's next action for A SHALL be merge (or wait on merge gates), not start B

#### Scenario: Contained merge releases the dependent

- **WHEN** prerequisite A has a merge-result commit contained in the fetched base under a merge train
- **THEN** dependent B MAY start subject to other scheduling rules
- **AND** train status SHALL show A as integrated

### Requirement: dependency_deadlock SHALL NOT fire for non-admitted or soft dependency references

The engine SHALL form eligibility gates and the `dependency_deadlock` stop only from
**admitted hard waits** present on each item's compiled `depends_on` and
`external_depends_on` after work-list hard-wait admission. References that population
recorded only as `ignored_dep` (including off-selector open issues, closed/merged
targets, and soft Related prose that never entered the raw declared set) SHALL NOT
make an item ineligible and SHALL NOT appear in a deadlock chain as an awaited
dependency. Real admitted in-snapshot open prerequisites retain existing hold and
deadlock behavior. This requirement composes with — and does not weaken — the rule
that dependency-independent items continue while others are gated.

#### Scenario: Off-selector open reference does not deadlock the ship

- **WHEN** the only remaining non-terminal item is issue `A`
- **AND** `A`'s body still mentions open issue `B` under `## Dependencies` or via
  `Depends on: #B`
- **AND** hard-wait admission ignored `B` because `B` is not on the train selector
- **AND** `A` has no admitted hard waits remaining
- **THEN** `A` SHALL be eligible to start subject to other non-dependency gates
- **AND** the run SHALL NOT stop with reason `dependency_deadlock` solely because of `B`

#### Scenario: Admitted open on-selector dependency still deadlocks when alone

- **WHEN** the only remaining non-terminal items are gated on admitted hard waits whose
  targets are open on the selector and not yet terminal-success
- **AND** no item is `in_progress` and none is eligible
- **THEN** the run SHALL stop with reason `dependency_deadlock`
- **AND** the deadlock chain SHALL name only admitted hard-wait dependencies

#### Scenario: Soft Related prose never appears in a deadlock chain

- **WHEN** issue `A` mentions `#B` only under Related / see-also soft prose
- **THEN** no deadlock chain entry for `A` SHALL name `B` as an awaited dependency
- **AND** no `dependency_deadlock` SHALL be attributed to that soft reference

### Requirement: External pending gates SHALL apply only to remaining admitted external hard waits

The engine SHALL apply external pending gates only to ids that remain on
`external_depends_on` after hard-wait admission. When an item still carries such ids, the
existing three-valued external verification (satisfied / pending / unsatisfiable) and
skip/deadlock rules continue to apply to those ids. Population that drops off-selector
and closed candidates before compile SHALL leave `external_depends_on` empty for those
candidates so they never enter external pending. The engine SHALL NOT re-introduce an
ignored off-selector open issue as a pending external gate on a later supervisor tick
without a fresh compile that re-admits it under the same admission rules.

#### Scenario: Ignored off-selector id is absent from external_depends_on

- **WHEN** issue `A` declares `#B` and admission ignores `B` as `not_on_selector`
- **THEN** the compiled item for `A` SHALL have no `B` on `external_depends_on`
- **AND** external status computation SHALL NOT treat `B` as a pending gate for `A`

#### Scenario: Remaining admitted external hard wait still blocks when pending

- **WHEN** an item retains an admitted external hard wait id on `external_depends_on`
- **AND** live observation classifies that id as pending
- **THEN** that item SHALL NOT be eligible to start
- **AND** existing deadlock rules for a frontier gated only on such pending externals
  continue to apply
