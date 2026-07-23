## Why

The integrated durable-loop stack landed as a sequence of separately-reviewed changes — the
in-repo supervisor (#512, `durable-loop-supervisor`), verified live reconciliation (#511,
`durable-run-reconciliation`), external dependency integrity (#513,
`durable-run-dependency-integrity`), typed blocker classification and recovery
(`durable-blocker-classification`, `blocked-recovery-recipes`), and blocker auto-filing (#538,
`durable-run-blocker-auto-file`). Each capability is unit-tested in isolation through its injected
seam, but nothing yet proves that the *composed* runtime carries a real multi-item run all the way
through — that the supervisor's reconcile → select → dispatch → record cycle, the merge-refresh
reconciliation barrier that gates a dependent item, same-item recovery/resume, the evidence trail,
and the "never mutate the remote twice" invariant actually hold **together** on a run with more
than one item and a real recoverable interruption.

Issue #515 (migrated from `comamitc/goal-loop#6`) closes that gap: a bounded **two-item live
pilot** that drives Agent Pipeline's own durable loop, on its own repository, through exactly the
composition-level behaviors that the isolated unit tests cannot cover. Because a live pilot is by
definition non-hermetic and non-repeatable in CI, this change defines the pilot as a first-class,
falsifiable capability with two verification tiers: a **hermetic composition simulation** that
reproduces the full five-behavior sequence deterministically through the existing injected seams
(so CI proves the assertions bite with zero real I/O, honoring the repo's no-network test
discipline), and a **live-pilot runbook + evidence-bundle contract** that pins exactly which
artifacts the real live run must capture to be judged done. This mirrors the non-OpenSpec planning
path: the acceptance criteria below are the observable outcomes; the spec deltas' `#### Scenario:`
blocks make each one precise.

## What Changes

- **A bounded two-item pilot fixture.** Define a reproducible pilot run of exactly two items — item
  **A** and item **B**, where B carries an `external_depends_on` edge on A — under the contract's
  `max_active_items: 1`. This is the minimal shape that forces every composition behavior: a
  dependency gate, a single-active-item invariant, and a merge-refresh barrier between the two
  items.
- **A recoverable-blocker + same-item-resume leg.** The pilot drives item A into a `blocked`
  transition carrying a *recoverable* `DurableBlockerClass` (e.g. `transient-rate-limit` or
  `implementation-ci`), then exercises recovery and a supervisor resume that continues the **same**
  item A — not a freshly-started item — appending a `resume` marker to the action-evidence trail and
  running a reconciliation pass on resume.
- **A merge-refresh reconciliation barrier.** The pilot proves item B stays ineligible to start
  until a reconciliation pass observes A's PR **merged** in live truth (its external dependency
  resolves to *satisfied* only from the engine-owned observation seam, never a caller claim), and
  that B is released to start on the first cycle after that observation.
- **A durable evidence bundle.** The pilot emits a single evidence bundle that references the
  concrete durable artifacts proving each behavior — the ledger item history, the action-evidence
  timeline (including the `resume` marker), the sequence-numbered reconciliation records, the merge
  observation that cleared the barrier, and the terminal condition — so a reviewer can verify the
  pilot from recorded truth rather than a narrative summary.
- **A no-duplicate-external-action invariant.** The pilot proves that replaying an already-applied
  cycle (a crash-and-resume, or a redundant reconciliation over a `merged` item) performs **no**
  second external mutation — no duplicate PR, issue, label write, or merge — asserted through the
  injected seam's recorded write calls.
- **Two verification tiers.** (1) A **hermetic composition simulation** test that drives the entire
  A→blocker→resume→merge-barrier→B→terminal sequence through the existing `SupervisorDeps` /
  `ReconcileObserveDeps` fakes with zero real network, git, or subprocess calls, with every
  assertion proven to bite (fails without the composed behavior). (2) A **live-pilot runbook +
  evidence-bundle contract** documenting the exact steps and the exact captured artifacts required
  for the real live run against a GitHub repository to be judged complete.

This change adds **no** new engine feature and changes **no** stage behavior: it composes and pins
the behavior already shipped. It introduces no auto-merge path (golden rule #4) — the pilot's item
A is merged by a human, and the pilot only *observes* that merge to clear the barrier.

## Acceptance Criteria

- [ ] A reproducible two-item pilot fixture exists (item A, item B with `external_depends_on: [A]`,
  contract `max_active_items: 1`) and is driven end-to-end by the hermetic composition simulation.
- [ ] The simulation drives item A into a `blocked` transition carrying a recoverable
  `DurableBlockerClass`, then recovers and **resumes the same item A** — asserting no second item is
  started for A, a `resume` action-evidence marker is appended, and a reconciliation pass runs on
  resume.
- [ ] The simulation proves item B is ineligible to start while A's dependency is `pending`
  (A's issue/PR observed unmerged) and becomes eligible **only** on the first cycle after a
  reconciliation observes A's PR `merged` in live truth — the merge-refresh barrier.
- [ ] Barrier resolution is driven **only** by the engine-owned observation seam: a caller claim
  that A is merged, absent a supporting live observation, does **not** release item B.
- [ ] The pilot emits one evidence bundle referencing the concrete durable artifacts for each
  behavior (item A/B ledger history, the action-evidence timeline including the `resume` marker, the
  sequence-numbered reconciliation records, the merge observation that cleared the barrier, and the
  terminal condition); the bundle is derivable from recorded run state, not a free-form summary.
- [ ] The simulation asserts **no duplicate external action**: replaying an already-applied cycle
  (crash-and-resume, or a redundant reconciliation over a `merged` item) records **zero** additional
  external mutations (no duplicate PR, issue, label write, or merge) through the injected seam.
- [ ] The hermetic simulation performs **zero** real network, git, and subprocess calls, and every
  new assertion is proven to bite (the test fails when the corresponding composed behavior is
  defeated).
- [ ] A live-pilot runbook documents the exact steps to run the real two-item pilot against a
  GitHub repository and enumerates the exact evidence-bundle artifacts that the completed live run
  must capture to be judged done, including how a human performs A's merge (the pipeline never
  merges).
- [ ] The real live two-item pilot is executed and its captured evidence bundle demonstrates all
  five behaviors (recoverable blocker, same-item resume, merge-refresh barrier, evidence reporting,
  no duplicate external actions); the captured bundle is linked from issue #515.
- [ ] `node scripts/build.mjs` regenerates the plugin mirror and `npm run ci` (including
  `openspec validate --all`) is green.

## Capabilities

### New Capabilities

- `durable-run-two-item-live-pilot`: a bounded, reproducible two-item acceptance pilot that proves
  the composed durable-loop runtime (supervisor cycle, verified reconciliation, external-dependency
  merge-refresh barrier, recoverable-blocker recovery with same-item resume, evidence reporting, and
  the no-duplicate-external-action invariant) end-to-end — verified hermetically in CI through the
  existing injected seams and executed once for real against a live GitHub repository with a
  captured evidence bundle.

## Impact

- **Specs:** one new `durable-run-two-item-live-pilot` capability. No existing requirement is
  modified or removed — this change composes and pins already-shipped behavior across
  `durable-loop-supervisor`, `durable-run-reconciliation`, `durable-run-dependency-integrity`,
  `durable-blocker-classification`, `blocked-recovery-recipes`, and `evidence-bundle`.
- **Code (implementation step only, not this change):** a new hermetic composition simulation test
  under `core/test/` driving `driveSupervisor` / `runSupervisorCycle` and `reconcile` through the
  existing `SupervisorDeps` and `ReconcileObserveDeps` fakes (no new production module strictly
  required — the pilot exercises shipped code); a small shared pilot fixture builder; and a
  live-pilot runbook document (e.g. under `hosts/_shared/` docs or `docs/`) plus the evidence-bundle
  contract it references.
- **Interoperability:** additive and test-only in CI. No new external write path, no new config key,
  and no auto-merge/auto-release/auto-deploy is introduced (golden rule #4). The freeform
  (non-OpenSpec) pipeline path is unaffected.
