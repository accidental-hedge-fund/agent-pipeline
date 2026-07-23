## Tasks

## 1. Types & schema
- [ ] 1.1 Add `external_depends_on: string[]` to `LoopContractItem` (`core/scripts/loop/types.ts`),
      documented as out-of-snapshot dependency ids preserved but non-order-constraining.
- [ ] 1.2 Add `skipped` to the `LoopItemState` union (terminal, dependency-propagated); update any
      `isLoopItemState`-style guard if present.
- [ ] 1.3 Add `dependency_deadlock` to `LoopStopRecord.reason` and a structured `deadlock_chain?:
      Array<{ item_id: string; waiting_on: string; kind: "in_run" | "external"; observed_state:
      string }>` payload; add an external-dependency-status type (`satisfied | unsatisfiable |
      pending`).
- [ ] 1.4 Add an `upgradeContractForDependencyIntegrity` (or extend the existing
      `upgradeContractForRecovery`) so a pre-change contract reads back with `external_depends_on: []`.

## 2. Compilation: preserve external dependencies
- [ ] 2.1 In the compile path, partition each item's declared dependencies into in-snapshot
      (`depends_on`) and out-of-snapshot (`external_depends_on`) by membership in the item-id set.
- [ ] 2.2 Keep the deterministic topological ordering and the cycle/duplicate-id refusals operating on
      `depends_on` only (external ids never constrain ordering and never form a refused cycle).

## 3. External-dependency verification
- [ ] 3.1 Extend the `ReconcileObserveDeps` seam (or add a sibling read) to expose an external issue's
      closed state and close reason (e.g. `stateReason`) and linked-PR merged state — confirm the real
      `gh --json` field shape before coding (golden rule #5).
- [ ] 3.2 Add a pure classifier `externalDependencyStatus(identity)` →
      `satisfied | unsatisfiable | pending` (closed-completed / PR-merged → satisfied; closed-not-planned
      → unsatisfiable; open → pending).
- [ ] 3.3 Gate eligibility on external dependencies: an item with any non-`satisfied` external
      dependency is ineligible to start (verification through the injected seam, no real I/O in tests).

## 4. Skip propagation
- [ ] 4.1 Add `propagateSkips(contract, ledger, externalStatuses)` that transitions the transitive
      `pending`/`blocked` dependents of any `abandoned`/`skipped` in-run dependency, or any
      `unsatisfiable` external dependency, to `skipped` — appending a history entry naming the causing
      dependency and emitting a `loop_item_skipped` event. A dependent with an alternative satisfiable
      path is not skipped.
- [ ] 4.2 Enforce the transition graph: `skipped` is reachable only from `pending`/`blocked` and is
      terminal (no outgoing edges); refuse every other edge into/out of `skipped`.
- [ ] 4.3 Count `skipped` as terminal for run completion (extend `DONE_OR_ABANDONED` /`allDone` and the
      read-only status projection).

## 5. Dependency-deadlock detection & continuation
- [ ] 5.1 Update `eligibleIndependentItems` so `abandoned`, `skipped`, and non-`satisfied`
      externally-gated dependencies exclude a candidate (join the existing `blocked`-dep exclusion).
- [ ] 5.2 Add `detectDependencyDeadlock(contract, ledger, externalStatuses)` → the `deadlock_chain`
      (or null) when no item is `in_progress`, no item is eligible, and ≥1 non-terminal item is gated
      on a pending/unsatisfiable dependency.
- [ ] 5.3 In the supervisor selection path, after applying propagation: if a deadlock chain is
      detected, record a `dependency_deadlock` stop (with the chain) and emit `loop_run_stopped`
      instead of the bare `no_eligible_item` spin. Dependency-independent items still run first; the
      deadlock stop fires only when none can run.

## 6. Tests (each must bite — fail without the change)
- [ ] 6.1 Compilation: a mixed snapshot puts external ids in `external_depends_on`, keeps them out of
      `depends_on`, and leaves ordering unchanged; in-snapshot cycle and duplicate id still refused.
- [ ] 6.2 Verification: item ineligible while external issue open; eligible once closed-completed /
      PR-merged; asserts zero real network/git/subprocess calls via injected fakes.
- [ ] 6.3 Propagation: dependent of an abandoned item becomes `skipped` (not `pending`); dependent
      with an alternative path is not skipped; unsatisfiable external dep skips its dependent.
- [ ] 6.4 Transition graph: runtime enumeration admits exactly `pending→skipped` and `blocked→skipped`
      and refuses all other `skipped` edges.
- [ ] 6.5 Deadlock: an externally-gated frontier stops with `dependency_deadlock` and a chain naming
      each stuck item and its dependency; the pre-fix silent spin to `supervisor_no_progress` no
      longer occurs.
- [ ] 6.6 Continuation: an independent item reaches `ready` before any deadlock is reported.

## 7. Mirror & gate
- [ ] 7.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 7.2 `npm run ci` green from repo root (`ci:core`, `build.mjs --check`, install-smoke,
      `openspec validate --all`).
