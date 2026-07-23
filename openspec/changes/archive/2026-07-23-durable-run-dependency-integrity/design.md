## Context

The integrated durable engine (`core/scripts/loop/`) already models inter-item dependencies in its
types — `LoopContractItem.depends_on: string[]`, `ordering: "dependency_sequential"` — and honors
them in selection (`eligibleIndependentItems`, `recovery.ts:589`). But three pieces goal-loop#5 added
on the standalone core were never ported:

- Out-of-snapshot ("external") dependencies are **dropped** at compile time
  (`durable-loop-engine` "Dependency ordering" requirement, scenario "An out-of-snapshot dependency
  is dropped").
- There is no propagation of an `abandoned` item's fate to its dependents — `eligibleIndependentItems`
  excludes items whose dep is `blocked`, and requires deps be in `DONE_STATES` (`ready`/`merged`/
  `released`/`deployed`), but `abandoned` is neither, so a dependent of an abandoned item silently
  stalls `pending` forever.
- A structurally unrunnable frontier has no typed signal — the supervisor records a bare
  `no_eligible_item` (`supervisor.ts:238`) and accrues no-progress until the generic
  `supervisor_no_progress` watchdog trips.

This change ports those pieces, reusing the verified live observation seam introduced by
`durable-run-reconciliation` (#511) so external dependencies are proven from live GitHub truth rather
than a caller claim — the same invariant that governs remote-proving item transitions.

## Goals / Non-Goals

**Goals**
- Preserve external dependencies through compilation and verify them from live truth before a
  dependent starts.
- Propagate a terminal `skipped` state to the transitive dependents of an abandoned/skipped/
  unsatisfiable dependency, with recorded provenance.
- Report a typed `dependency_deadlock` (with a structured chain) instead of a silent spin.
- Make the dependency-independent continuation policy explicit across abandon/skip/external gating.

**Non-Goals**
- Populating `depends_on` / `external_depends_on` from GitHub issue relationships in the production
  work-list compiler (`compileWorkListRun` still emits empty deps today). This change defines how the
  engine *handles* declared dependencies; where the edges come from (import, future discovery) is out
  of scope.
- Any auto-merge / auto-release / auto-deploy path (golden rule #4). External verification is
  read-only.
- Changing the block-recovery machinery (`DurableBlockerClass`, budgets, `run_fatal`) — this change
  composes with it, it does not alter it.

## Decisions

### Decision 1: `external_depends_on` is a separate list, not a flag on `depends_on`

Compilation partitions an item's declared dependencies by membership in the snapshot: in-snapshot ids
stay in `depends_on` (order-constraining, cycle-checked), out-of-snapshot ids move to a new
`external_depends_on: string[]`. Keeping them in separate lists means the existing deterministic
topological sort and cycle check operate on `depends_on` unchanged (external ids name work the run
cannot schedule, so they must not participate in ordering), while external ids are still preserved
and available to the verification gate. Alternative considered: a single tagged list — rejected
because every existing ordering/cycle consumer would need to filter it, a larger and more error-prone
diff than an additive field.

### Decision 2: `skipped` is a new terminal state, distinct from `abandoned`

`abandoned` already means "explicitly given up on" — reached from `in_progress` (execution reported
abandoned) or from a `paused`/`waiting` hold (`abandonHold`). A dependency-propagated skip is
semantically different: the item was **never attempted** because a prerequisite will never be
delivered. Reusing `abandoned` would erase that provenance and conflate operator/execution intent
with mechanical propagation. So `skipped` is added as its own terminal state, reachable **only** from
`pending` or `blocked` (an item that had not yet succeeded when its dependency terminated
non-successfully) and only via propagation — never a caller-requested transition. Like `abandoned`,
`skipped` counts as terminal for run completion (`allDone` / the `DONE_OR_ABANDONED` set becomes
"done, abandoned, or skipped").

### Decision 3: External-dependency satisfaction is read from live truth, three-valued

An external dependency is named by an issue number (the same id convention as items). Its state is
resolved through the engine-owned `ReconcileObserveDeps` seam (the #511 reconciliation seam — no
caller claim):
- **satisfied** — the issue is observed closed-as-completed, or its linked PR is observed merged;
- **unsatisfiable** — the issue is observed closed-as-not-planned (the prerequisite will not be
  delivered);
- **pending** — the issue is observed open.

An item with any external dependency not in the **satisfied** state is ineligible to start. An
**unsatisfiable** external dependency is a propagation trigger (Decision 2) — the dependent is
`skipped`. A **pending** external dependency keeps the item waiting and, if it is part of an
otherwise-unrunnable frontier, feeds the deadlock report (Decision 4). Reading the close reason
requires the observation seam to expose the issue's closed/close-reason (e.g. `stateReason`); the
seam is engine-owned, so unit tests inject a fake and perform no real I/O, exactly as
`durable-run-reconciliation` established.

### Decision 4: `dependency_deadlock` is a distinct stop reason with a structured chain

A structurally unrunnable frontier is a *terminal* condition, not a no-progress accident, so it gets
its own `LoopStopRecord.reason` (`dependency_deadlock`) rather than being folded into
`supervisor_no_progress`. It is detected during selection, **after** skip propagation has been
applied (so pure in-run abandon/skip chains have already resolved to `skipped` → they no longer count
as non-terminal): the run is deadlocked when no item is `in_progress`, `eligibleIndependentItems`
(with external gating) is empty, and at least one item is still non-terminal and gated on a pending or
unsatisfiable dependency. The stop record carries a `deadlock_chain`: for each stuck item, the
dependency (in-run id or external issue) it waits on and that dependency's observed state — so the
operator sees exactly which external work must land (or which abandoned item must be revisited) to
unblock the run.

### Decision 5: Continuation policy is generalized, not duplicated

The existing `durable-blocker-classification` requirement "Independent eligible items SHALL continue
when policy permits" governs continuation past a **block**. This change does not restate or weaken it;
it generalizes eligibility exclusion so `abandoned`, `skipped`, and externally-gated dependencies are
treated the same as `blocked` dependencies for selection, and it establishes that the
`dependency_deadlock` stop fires **only** when no dependency-independent item can run. A
dependency-independent item therefore always runs to completion before any deadlock is reported.

## Risks / Trade-offs

- **Close-as-not-planned as "unsatisfiable" may over-skip.** An issue closed as not-planned and later
  reopened would have already skipped its dependents. Mitigation: propagation is driven by the
  latest verified observation each cycle; a reopened dependency simply stops being a propagation
  trigger going forward, and `skipped` dependents are surfaced in the run's status for operator
  review. This matches the engine's existing "surface, don't silently over-correct" stance from
  reconciliation.
- **Adding a state touches the transition graph.** `skipped` must be threaded through the graph
  enforcement, `allDone`, and the read-only status projection. The transition-graph requirement is
  modified (not merely extended) to keep a single authoritative graph. A runtime test enumerates the
  edges since types are stripped.

## Migration

Additive. A contract compiled with no out-of-snapshot dependencies has `external_depends_on: []` and
behaves exactly as today; a run with no abandon/skip and no external gating never propagates and never
deadlocks. Legacy goal-loop import is unaffected — imported contracts gain an empty
`external_depends_on` on read (upgrade-on-read, mirroring `upgradeContractForRecovery`).
