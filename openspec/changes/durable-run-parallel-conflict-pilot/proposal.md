## Why

The conflict-aware *parallel* durable-loop stack landed as a sequence of separately-reviewed
changes: ownership + conflict declarations and the pairwise conflict evaluator (#529,
`durable-run-ownership-conflicts`), and the independence scheduler that admits concurrency only
under an explicit run policy with proven independence (#530,
`durable-run-independent-scheduler`) — layered on the already-shipped verified reconciliation
(#511, `durable-run-reconciliation`), dependency integrity (#513,
`durable-run-dependency-integrity`), and the in-repo supervisor (#512,
`durable-loop-supervisor`). Each capability is unit-tested in isolation through its injected seam,
but nothing yet proves that the *composed* runtime carries a real **multi-item concurrent** run all
the way through — that disjoint items actually start together in separate worktrees, that an
overlapping item is serialized with a durable conflict reason, that mid-run changed-file overlap
parks and replans instead of letting two conflicting items prepare a merge concurrently, and that
merge / base-refresh / final reconciliation stay globally serialized after concurrent
implementation and review work.

Issue #531 (part of #528, depends on #530) closes that gap for the parallel path — mirroring what
#515 (`durable-run-two-item-live-pilot`) did for the serialized single-active-item path. It defines
a bounded **conflict-aware parallel pilot** that drives Agent Pipeline's own durable loop through
exactly the composition-level behaviors the isolated unit tests cannot cover. Because a live
parallel run is by definition non-hermetic and non-repeatable in CI, this change defines the pilot
as a first-class, falsifiable capability with two verification tiers: a **hermetic composition
simulation** that reproduces the full disjoint-concurrency → serialized-conflict →
changed-file-overlap-park → serialized-merge sequence deterministically through the existing
injected scheduler / ownership / reconciliation seams (so CI proves the assertions bite with zero
real I/O, honoring the repo's no-network test discipline), and a **live-pilot runbook +
evidence-bundle contract** that pins exactly which artifacts the real live run must capture to be
judged done. This mirrors the non-OpenSpec planning path: the acceptance criteria below are the
observable outcomes; the spec deltas' `#### Scenario:` blocks make each one precise.

## What Changes

- **A bounded conflict-aware parallel pilot fixture.** Define a reproducible pilot run of items
  under a `concurrency` run policy whose budget is greater than one: two **disjoint** items — item
  **A** and item **B**, whose normalized ownership surfaces the pairwise evaluator proves
  `disjoint` — plus a third item **C** whose declared surfaces conflict with an admitted item (a
  co-owned shared surface or an explicit `conflicts_with` edge). This is the minimal shape that
  forces every composition behavior: concurrent admission of a disjoint pair, serialization of a
  conflicting candidate with a structured reason, and (on A/B) an observed changed-file overlap that
  their declarations did not predict.
- **A concurrent disjoint-start leg.** The pilot proves items A and B are admitted into the
  concurrent set together, each assigned its **own separate managed worktree**, and that each item
  retains independent Pipeline evidence — one member's ledger history, action-evidence, and
  worktree identity never bleed into the other's.
- **A serialized-conflict leg.** The pilot proves item C is excluded from the concurrent set and
  left to run only after the active items drain, and that the durable planning record names exactly
  one structured conflict reason (co-owned shared surface, overlapping source glob, explicit edge,
  or unknown ownership) and the admitted item it conflicts with.
- **A mid-run changed-file-overlap park/replan leg.** The pilot proves that when concurrently-run
  items A and B are observed to have actually changed an **overlapping file** their declared
  ownership did not mark as shared, the scheduler **parks** the affected pair and records a durable
  **replan request** naming the file — rather than permitting either to proceed into concurrent
  merge preparation — while any unaffected item's independence evidence is preserved, and parking
  performs no external mutation.
- **A serialized merge-class leg.** The pilot proves that after the concurrent implementation and
  review work, merge / base refresh / final reconciliation remain **globally serialized**: no item
  is admitted into `in_progress` while a merge barrier is set, no two merge-class operations run at
  once, each admitted item still passes its own review and pre-merge gates, and the run still stops
  at `pipeline:ready-to-deploy`.
- **A durable evidence bundle.** The pilot emits a single evidence bundle that references the
  concrete durable artifacts proving each behavior — the observed concurrency (which items ran
  together), the pairwise ownership decisions and their structured reasons, per-item worktree
  identity, the changed-file-overlap detection and its replan request, and each item's terminal
  outcome — so a reviewer can verify the pilot from recorded truth rather than a narrative summary.
- **Two verification tiers.** (1) A **hermetic composition simulation** test that drives the entire
  disjoint-concurrency → serialized-conflict → changed-file-overlap-park → serialized-merge sequence
  through the existing scheduler / ownership-evaluator / `SupervisorDeps` / reconciliation fakes
  with zero real network, git, or subprocess calls, with every assertion proven to bite (fails
  without the composed behavior). (2) A **live-pilot runbook + evidence-bundle contract**
  documenting the exact steps and the exact captured artifacts required for the real live run
  against a GitHub repository to be judged complete.

This change adds **no** new engine feature and changes **no** stage behavior: it composes and pins
the behavior already shipped by #529 and #530. It introduces no auto-merge path (golden rule #4) —
the pilot's items are merged by a human, and the pilot only *observes* the merge surface; nothing
here relaxes a review gate or advances an item past `pipeline:ready-to-deploy`.

## Acceptance Criteria

- [ ] A reproducible conflict-aware parallel pilot fixture exists — items A and B with `disjoint`
  ownership declarations, item C conflicting with an admitted item, all under a `concurrency` run
  policy with budget greater than one — and is driven end-to-end by the hermetic composition
  simulation.
- [ ] The simulation proves items A and B are admitted into the concurrent set together, each
  assigned its **own separate managed worktree**, and each retains independent Pipeline evidence
  (no cross-member bleed of ledger history, action-evidence, or worktree identity).
- [ ] The simulation proves item C is serialized (excluded from the concurrent set until the active
  items drain) and that its durable planning record carries exactly **one** structured conflict
  reason naming the admitted item it conflicts with.
- [ ] The simulation proves that a mid-run **changed-file overlap** between A and B that their
  declarations did not predict **parks** the affected pair and records a durable **replan request**
  naming the overlapping file — and that neither parked item proceeds into concurrent merge
  preparation.
- [ ] The simulation proves parking is scoped: an unaffected item's independence evidence survives a
  parking event, and parking records the replan request with **no** external mutation (no merge,
  push, label write, or branch/worktree deletion).
- [ ] The simulation proves merge-class operations (the merge surface, base refresh, final
  reconciliation) stay **globally serialized** after the concurrent implementation/review work: no
  item starts while a merge barrier is set, no two merge-class operations overlap, each admitted
  item still passes its own review and pre-merge gates, and the run still stops at
  `pipeline:ready-to-deploy`.
- [ ] The pilot emits one evidence bundle referencing the concrete durable artifacts for each
  behavior — observed concurrency, the pairwise ownership decisions and structured reasons, per-item
  worktree identity, the changed-file-overlap conflict detection and its replan request, and each
  item's terminal outcome — derivable from recorded run state, not a free-form summary.
- [ ] The hermetic simulation performs **zero** real network, git, and subprocess calls, and every
  new assertion is proven to bite (the test fails when the corresponding composed behavior is
  defeated).
- [ ] A live-pilot runbook documents the exact steps to run the real conflict-aware parallel pilot
  against a GitHub repository and enumerates the exact evidence-bundle artifacts the completed live
  run must capture to be judged done, including how a human performs each merge (the pipeline never
  merges).
- [ ] The real live conflict-aware parallel pilot is executed and its captured evidence bundle
  demonstrates all five behaviors (disjoint concurrency with independent evidence, serialized
  conflict, changed-file-overlap park/replan, serialized merge-class integration, evidence
  reporting); the captured bundle is linked from issue #531.
- [ ] `node scripts/build.mjs` regenerates the plugin mirror and `npm run ci` (including
  `openspec validate --all`) is green.

## Capabilities

### New Capabilities

- `durable-run-parallel-conflict-pilot`: a bounded, reproducible conflict-aware parallel acceptance
  pilot that proves the composed conflict-aware concurrent durable-loop runtime (disjoint items
  starting together in separate worktrees with independent evidence, serialization of a conflicting
  item with a durable structured reason, mid-run changed-file-overlap parking with a replan request,
  globally-serialized merge / base-refresh / final reconciliation, and derived evidence reporting)
  end-to-end — verified hermetically in CI through the existing injected seams and executed once for
  real against a live GitHub repository with a captured evidence bundle.

## Impact

- **Specs:** one new `durable-run-parallel-conflict-pilot` capability. No existing requirement is
  modified or removed — this change composes and pins already-shipped behavior across
  `durable-run-ownership-conflicts`, `durable-run-independent-scheduler`,
  `durable-run-reconciliation`, `durable-run-dependency-integrity`, `durable-loop-supervisor`, and
  `evidence-bundle`.
- **Code (implementation step only, not this change):** a new hermetic composition simulation test
  under `core/test/` driving the scheduler, the pairwise ownership evaluator, and the supervisor /
  reconciliation cycle through their existing injected fakes (no new production module strictly
  required — the pilot exercises shipped code); a small shared parallel-pilot fixture builder; and a
  live-pilot runbook document plus the evidence-bundle contract it references.
- **Interoperability:** additive and test-only in CI. No new external write path, no new config key,
  and no auto-merge/auto-release/auto-deploy is introduced (golden rule #4). The freeform
  (non-OpenSpec) pipeline path is unaffected.
