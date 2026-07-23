## ADDED Requirements

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
