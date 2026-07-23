## Why

When the in-repo durable loop engine (#508) absorbed the standalone goal-loop core, it took a
deliberate shortcut on inter-item **dependencies**: the `durable-loop-engine` requirement
`Dependency ordering SHALL be deterministic and SHALL reject cycles` **drops** any declared
dependency on an item outside the run's snapshot ("the snapshot defines the run's world"), and the
engine has no concept of verifying, propagating, or reporting on dependencies beyond the
already-present dependency-independent continuation of blocked items (`eligibleIndependentItems`,
`recovery.ts`). goal-loop#5 (this issue, #513) added that missing dependency machinery on the
standalone core; this change ports it onto the integrated durable engine.

That shortcut leaves three correctness holes for a durable, cross-engine (Claude ↔ Codex),
restart-surviving run:

- **External dependencies are silently dropped.** A dependency on an issue *outside* the run's item
  set is discarded at compile time, so a dependent item can start (and be driven to
  `ready-to-deploy`) before its real prerequisite is delivered — the run has no way to say "hold this
  item until issue #N lands."
- **Abandonment/skip does not propagate.** When an item is `abandoned`, its transitive dependents
  can never satisfy their `depends_on` (abandoned is neither a `DONE_STATE` nor the excluded
  `blocked` set that `eligibleIndependentItems` checks), so those dependents silently stall as
  `pending` forever — the run never records why they were never attempted.
- **A dependency-stalled run spins silently.** When no item is eligible to start because the
  remaining frontier is gated on unfinished or unsatisfiable dependencies, the supervisor records a
  bare `no_eligible_item` cycle and accrues no-progress until the generic `supervisor_no_progress`
  watchdog trips — it never reports *which* items are stuck on *which* dependencies. There is no
  typed dependency-deadlock signal.

This change ports goal-loop#5's dependency machinery — external-dependency preservation and live
verification, a propagated `skipped` terminal state, typed dependency-deadlock reporting, and an
explicit dependency-independent continuation policy that spans abandon/skip/external gating — while
keeping the engine's injected-seam, no-real-I/O **test** discipline intact. It composes with the
verified reconciliation seam (#511) — external dependencies are verified from live GitHub truth, not
a caller claim.

## What Changes

- **External dependencies are preserved, not dropped.** Contract compilation partitions each item's
  declared dependencies into **in-snapshot** dependencies (retained in `depends_on`, constraining the
  deterministic ordering exactly as today) and **out-of-snapshot** dependencies (retained in a new
  `external_depends_on` list). External dependencies do **not** constrain ordering (they name work
  the run cannot schedule) but are preserved as prerequisites the engine verifies. A dependency cycle
  among in-snapshot items is still refused; duplicate ids are still refused.
- **External dependencies are verified against live truth.** Before an item with external
  dependencies may start, the engine verifies each external dependency through the engine-owned live
  observation seam (`ReconcileObserveDeps`), never a caller claim: an external dependency is
  **satisfied** when its issue is observed closed-as-completed (or its linked PR observed merged),
  **unsatisfiable** when its issue is observed closed-as-not-planned, and **pending** when its issue
  is observed open. An item with any pending or unsatisfiable external dependency is not eligible to
  start.
- **A propagated `skipped` terminal state.** A new terminal item state `skipped` is added, reachable
  only from `pending` or `blocked`, entered only by dependency propagation. When a dependency reaches
  a terminal non-success state (`abandoned`, `skipped`, or an external dependency observed
  unsatisfiable), the engine propagates a `skipped` transition to that dependency's transitive
  dependents, appending a history entry that names the causing dependency and emitting an event —
  rather than leaving them stalled `pending`. `skipped`, like `abandoned`, counts as terminal for
  run completion.
- **Typed dependency-deadlock reporting.** A new `dependency_deadlock` stop reason (with a structured
  `deadlock_chain` payload) is recorded when the run's frontier is structurally unrunnable — no item
  is `in_progress`, no item is eligible to start, and at least one non-terminal item remains gated on
  a pending or unsatisfiable dependency — instead of spinning to the generic `supervisor_no_progress`
  watchdog. The payload names each stuck item and the dependency (in-run or external) it waits on,
  and the observed state of that dependency.
- **Explicit dependency-independent continuation policy.** The existing block-only continuation
  (`eligibleIndependentItems` + the `durable-blocker-classification` "Independent eligible items
  SHALL continue when policy permits" requirement) is generalized: `abandoned`, `skipped`, and
  externally-gated items are treated like blocked items for eligibility exclusion, and
  dependency-independent items SHALL continue to run to completion; the `dependency_deadlock` stop
  SHALL fire only when **no** dependency-independent item can run.

## Acceptance Criteria

- [x] Contract compilation partitions an item's declared dependencies into in-snapshot `depends_on`
  (order-constraining) and out-of-snapshot `external_depends_on` (preserved, non-order-constraining);
  a unit test compiling a snapshot with a mix asserts the external ids land in `external_depends_on`,
  are absent from `depends_on`, and do not affect the deterministic ordering — replacing the prior
  "out-of-snapshot dependency is dropped" behavior.
- [x] An in-snapshot dependency cycle is still refused as a validation failure and duplicate item ids
  are still refused; a regression test proves both.
- [x] An item with an external dependency whose issue is observed **open** is not eligible to start;
  the same item becomes eligible once that issue is observed **closed-as-completed** (or its linked PR
  merged); verification runs through the injected `ReconcileObserveDeps` seam and a unit test asserts
  **zero** real network, git, and subprocess calls.
- [x] A new terminal item state `skipped` exists, reachable only from `pending` or `blocked`, with no
  outgoing transitions; the transition-graph enforcement admits exactly those two inbound edges and
  refuses every other edge into or out of `skipped` (guarded by a runtime test, since types are
  stripped).
- [x] When an item is `abandoned` (or an external dependency is observed unsatisfiable), its
  transitive dependents are propagated to `skipped`, each with a history entry naming the causing
  dependency and an emitted event; a regression test shows the dependent is `skipped` (not left
  `pending`) and that a dependent with an *alternative* satisfiable path is **not** skipped.
- [x] A run whose only remaining non-terminal items are gated on pending or unsatisfiable
  dependencies, with no item in progress and none eligible, stops with a `dependency_deadlock` stop
  record whose `deadlock_chain` payload names each stuck item and the specific dependency (in-run or
  external) and its observed state — distinct from `supervisor_no_progress`; a regression test asserts
  the typed stop and that the pre-fix behavior (silent spin to `supervisor_no_progress`) no longer
  occurs.
- [x] A dependency-independent item continues to run to completion while another item is `abandoned`,
  `skipped`, or externally gated; the `dependency_deadlock` stop fires only when no
  dependency-independent item can run — proven by a test where an independent item reaches `ready`
  before any deadlock is reported.
- [x] `node scripts/build.mjs` regenerates the plugin mirror and `npm run ci` (including
  `openspec validate --all`) is green; every new regression test bites (fails without the change).

## Capabilities

### New Capabilities
- `durable-run-dependency-integrity`: preservation and live verification of a durable run's external
  dependencies, propagation of a terminal `skipped` state to the transitive dependents of an
  abandoned/skipped/unsatisfiable dependency, typed dependency-deadlock detection and reporting for a
  structurally unrunnable frontier, and an explicit dependency-independent continuation policy —
  all computed from the verified live observation seam and persisted through the durable ledger, stop
  record, and event log.

### Modified Capabilities
- `durable-loop-engine`: the `Dependency ordering SHALL be deterministic and SHALL reject cycles`
  requirement no longer **drops** an out-of-snapshot dependency — it **preserves** it as an external
  dependency; and the `The ledger SHALL admit only the defined item transition graph` requirement
  adds the terminal `skipped` state (inbound from `pending` and `blocked` only).

## Impact

- **Specs:** new `durable-run-dependency-integrity` capability; two modified requirements in
  `durable-loop-engine` (dependency ordering; item transition graph).
- **Code (implementation step only, not this change):** `core/scripts/loop/types.ts`
  (`external_depends_on` on `LoopContractItem`; `skipped` on `LoopItemState`; a `dependency_deadlock`
  `LoopStopRecord.reason` with a structured `deadlock_chain`); contract compilation
  (`compileWorkListRun` / the compile path) partitions declared dependencies; `core/scripts/loop/
  recovery.ts` (`eligibleIndependentItems` treats abandoned/skipped/externally-gated deps as
  excluding, plus an external-dependency verification gate through `ReconcileObserveDeps`); a new
  propagation helper (e.g. `propagateSkips`) and a deadlock-detection helper (e.g.
  `detectDependencyDeadlock`) in the loop module; and `core/scripts/loop/supervisor.ts` (invoke
  propagation and deadlock detection in the selection path instead of the bare `no_eligible_item`
  spin).
- **Interoperability:** additive to the contract/ledger — a contract with no external dependencies
  and no abandon/skip behaves exactly as today (`external_depends_on` empty, no propagation, no
  deadlock). The production work-list compiler currently emits `depends_on: []` per item, so existing
  runs are unaffected until dependencies are declared. Legacy goal-loop import is unaffected. No new
  external write path and no auto-merge/auto-release/auto-deploy is introduced (golden rule #4) — the
  engine only reads external truth and records durable state.
