## Tasks

## 1. Pilot fixture
- [ ] 1.1 Add a shared pilot fixture builder (co-located with the simulation test) that produces a
      compiled, locked two-item run: item **A** and item **B** with `B.external_depends_on = [A]`,
      contract `max_active_items: 1`, both items executable through the injected execution seam.
- [ ] 1.2 Provide a scripted `SupervisorDeps` execution fake whose per-cycle outcome sequence is
      data-driven, so the pilot can inject A's blocker, A's recovery, and B's success
      deterministically without a clock or randomness.

## 2. Recoverable blocker + same-item resume
- [ ] 2.1 Drive item A into a `blocked` transition carrying a recoverable `DurableBlockerClass`
      (e.g. `transient-rate-limit` / `implementation-ci`) through the fake, then apply the recovery
      path back to `in_progress`.
- [ ] 2.2 Exercise a supervisor resume (`driveSupervisor` with `resume: true` over a released/dead
      lock) and assert: the resumed run reconciles first, appends a `resume` action-evidence marker,
      and continues the **same** item A — no second/fresh item is started for A.

## 3. Merge-refresh reconciliation barrier
- [ ] 3.1 With A's PR observed unmerged, assert item B's external dependency resolves to `pending`
      and B is **not** eligible to start (single-active-item + dependency ordering hold).
- [ ] 3.2 Flip the `ReconcileObserveDeps` fake so A's PR is observed `merged`; assert the next
      reconciliation classes the barrier cleared and B becomes eligible on the first subsequent
      cycle — and only then.
- [ ] 3.3 Assert a caller-supplied claim that A is `merged`, absent a supporting live observation,
      does **not** release B (barrier resolves from verified truth only).

## 4. Evidence bundle
- [ ] 4.1 Emit one evidence bundle for the pilot run referencing: item A/B ledger history, the
      action-evidence timeline (including the `resume` marker), the sequence-numbered reconciliation
      records, the merge observation that cleared the barrier, and the terminal condition.
- [ ] 4.2 Assert the bundle is derived from recorded run state (ledger / events / action-evidence),
      not a free-form narrative, and that each of the five behaviors is locatable in it.

## 5. No duplicate external action
- [ ] 5.1 Replay an already-applied cycle (crash-and-resume, and a redundant reconciliation over a
      `merged` item) and assert **zero** additional external mutations are recorded through the
      injected seam — no duplicate PR, issue, label write, or merge.

## 6. Hermetic composition simulation
- [ ] 6.1 Compose 2–5 into a single end-to-end simulation test driving
      A → blocker → recovery/resume → merge-barrier → B → terminal through `driveSupervisor` /
      `runSupervisorCycle` / `reconcile` with the fakes; assert the run reaches the expected
      terminal condition (all items done/merged-observed).
- [ ] 6.2 Assert the simulation records **zero** real network, git, and subprocess calls.
- [ ] 6.3 Prove each assertion bites: temporarily defeat each composed behavior and confirm the
      corresponding assertion fails (document the bite checks in the test).

## 7. Live-pilot runbook & evidence contract
- [ ] 7.1 Write a live-pilot runbook (operator-facing) with the exact steps to run the real
      two-item pilot against a GitHub repository, including how a human performs A's merge (the
      pipeline never merges — golden rule #4) and how the recoverable blocker is induced.
- [ ] 7.2 Enumerate the evidence-bundle artifact contract the completed live run must capture to be
      judged done (the five-behavior checklist mapped to concrete recorded artifacts).

## 8. Execute the live pilot
- [ ] 8.1 Run the real two-item live pilot against a GitHub repository per the runbook.
- [ ] 8.2 Capture the evidence bundle demonstrating all five behaviors and link it from issue #515.

## 9. Gates
- [ ] 9.1 Regenerate the plugin mirror (`node scripts/build.mjs`) and run `npm run ci` green,
      including `openspec validate --all`.
