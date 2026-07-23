## Tasks

## 1. Parallel-pilot fixture
- [x] 1.1 Add a shared parallel-pilot fixture builder (co-located with the simulation test) that
      produces a compiled, locked run under a `concurrency` run policy with budget greater than one:
      item **A** and item **B** with `disjoint` ownership declarations (non-overlapping exclusive
      source globs, no co-owned shared surface, no explicit edge), and item **C** whose declaration
      conflicts with an admitted item (co-owned shared surface or explicit `conflicts_with`).
- [x] 1.2 Provide a scripted scheduler / `SupervisorDeps` execution fake whose per-cycle outcome
      sequence is data-driven, so the pilot can inject the concurrent A/B admission, C's
      serialization, A↔B changed-file overlap, and the serialized merge phase deterministically
      without a clock or randomness.

## 2. Concurrent disjoint start with independent evidence
- [x] 2.1 Drive a scheduling pass and assert A and B are admitted into the concurrent set together
      (budget honored, pairwise `disjoint`), each assigned its **own separate managed worktree**.
- [x] 2.2 Assert each item retains independent Pipeline evidence — one member's ledger history,
      action-evidence, and worktree identity never appear in the other's — and that a failure of one
      member does not re-drive or invalidate the other's evidence.

## 3. Serialized conflict with a durable reason
- [x] 3.1 Assert item C is excluded from the concurrent set (serialized to run after the active
      items drain).
- [x] 3.2 Assert C's durable planning record carries exactly **one** structured conflict reason
      (co-owned shared surface, overlapping source glob, explicit edge, or unknown ownership) and
      names the admitted item it conflicts with.

## 4. Mid-run changed-file overlap parks/replans
- [x] 4.1 Flip the observation fake so concurrently-run A and B are seen to have actually changed an
      **overlapping file** their declarations did not mark shared; assert the scheduler **parks**
      the affected pair and records a durable **replan request** naming the file.
- [x] 4.2 Assert neither parked item proceeds into concurrent merge preparation, an unaffected
      item's independence evidence survives the parking event, and parking performs **no** external
      mutation (no merge, push, label write, or branch/worktree deletion).

## 5. Serialized merge-class integration
- [x] 5.1 After the concurrent implementation/review work, assert merge / base refresh / final
      reconciliation are globally serialized: no item is admitted into `in_progress` while a merge
      barrier is set, and no two merge-class operations run concurrently.
- [x] 5.2 Assert each admitted item still passes its own review and pre-merge gates and the run
      still stops at `pipeline:ready-to-deploy` (the scheduler grants no merge authority).

## 6. Evidence bundle
- [x] 6.1 Emit one evidence bundle for the pilot run referencing: the observed concurrency (which
      items ran together), the pairwise ownership decisions and their structured reasons, per-item
      worktree identity, the changed-file-overlap conflict detection and its replan request, and each
      item's terminal outcome.
- [x] 6.2 Assert the bundle is derived from recorded run state (planning record / ledger / events /
      action-evidence), not a free-form narrative, and that each of the five behaviors is locatable
      in it.

## 7. Hermetic composition simulation
- [x] 7.1 Compose 2–6 into a single end-to-end simulation test driving the
      disjoint-concurrency → serialized-conflict → changed-file-overlap-park → serialized-merge
      sequence through the scheduler / ownership-evaluator / `SupervisorDeps` / reconciliation fakes;
      assert the run reaches the expected terminal condition.
- [x] 7.2 Assert the simulation records **zero** real network, git, and subprocess calls.
- [x] 7.3 Prove each assertion bites: temporarily defeat each composed behavior (concurrent
      admission, conflict serialization, changed-file-overlap parking, serialized merge barrier) and
      confirm the corresponding assertion fails (document the bite checks in the test).

## 8. Live-pilot runbook & evidence contract
- [x] 8.1 Write a live-pilot runbook (operator-facing) with the exact steps to run the real
      conflict-aware parallel pilot against a GitHub repository, including how a human performs each
      merge (the pipeline never merges — golden rule #4), how the disjoint pair is chosen, and how a
      mid-run changed-file overlap is induced.
- [x] 8.2 Enumerate the evidence-bundle artifact contract the completed live run must capture to be
      judged done (the five-behavior checklist mapped to concrete recorded artifacts: concurrency,
      pairwise decisions, worktree identity, conflict detections, terminal outcomes).

## 9. Execute the live pilot
- [ ] 9.1 Run the real conflict-aware parallel live pilot against a GitHub repository per the
      runbook. **Blocked in this automated turn**: this step requires a live GitHub repository, a
      long-running/human-attended parallel `pipeline:loop` session, and a human pressing the merge
      button per the runbook (golden rule #4) — none of which an unattended single-turn
      implementation pass can perform. Tier 1 (the hermetic composition simulation, tasks 1–7) is
      the CI-enforced proof; this step remains for an operator to execute per the runbook.
- [ ] 9.2 Capture the evidence bundle demonstrating all five behaviors and link it from issue #531.
      Depends on 9.1.

## 10. Gates
- [x] 10.1 Regenerate the plugin mirror (`node scripts/build.mjs`) and run `npm run ci` green,
      including `openspec validate --all`.
