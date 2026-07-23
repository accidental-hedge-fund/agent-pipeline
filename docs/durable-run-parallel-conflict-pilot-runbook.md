# Durable-run conflict-aware parallel pilot — runbook (#531)

_Capability: `durable-run-parallel-conflict-pilot`. Tier 2 of the pilot (see
`openspec/changes/durable-run-parallel-conflict-pilot/design.md` — Tier 1 is the hermetic
composition simulation at `core/test/durable-run-parallel-conflict-pilot.test.ts`)._

This is the operator-facing procedure for running the **real** conflict-aware parallel
durable-loop pilot against a live GitHub repository, and the evidence-bundle contract the
completed run must satisfy to be judged done. It exercises exactly the same five behaviors the
hermetic simulation proves deterministically — concurrent disjoint admission with independent
evidence, planning-time conflict serialization, mid-run changed-file-overlap parking/replanning,
globally-serialized merge-class integration, and derived evidence reporting — but against real
`gh`/git state, real concurrent managed worktrees, and a real human merge.

The pipeline never merges (CLAUDE.md golden rule #4). Step 8 below is a human action; the pilot
only observes it. This runbook is the parallel analog of
`docs/durable-run-two-item-live-pilot-runbook.md` (#515), which pins the same kind of procedure
for the serialized single-active-item path.

## Prerequisites

- A GitHub repository the operator can push to and open PRs against (a scratch repo or a
  low-stakes corner of a real one — this pilot files real issues/PRs).
- `pipeline:loop` installed and runnable against that repository, with a `concurrency` run policy
  whose `max_concurrent` is at least 2 (however the operator's compile step accepts a run-policy
  override).
- Three GitHub issues filed ahead of time, each with an ownership declaration in its durable-loop
  discovery input (however the operator's discovery/compile step accepts one — e.g. a contract
  override or an explicit per-issue annotation):
  - **Item A** — declares an exclusive ownership surface disjoint from item B's (e.g. a distinct
    top-level source directory).
  - **Item B** — declares an exclusive ownership surface disjoint from item A's.
  - **Item C** — declares a `conflicts_with` edge naming item A (or a shared ownership surface
    co-owned with A) — the closed-set kind used doesn't matter; the runbook only requires that the
    pairwise evaluator return `conflict` for the A↔C pair.
- A way to choose the disjoint pair deliberately: pick two issues whose real changes are, in fact,
  confined to non-overlapping source directories, so the ownership declaration is honest — the
  overlap induced in step 5 must come from an UNPREDICTED file (e.g. a shared config/lockfile),
  never from the declared exclusive surfaces themselves.

## Procedure

1. **Compile and start the run.** Start `pipeline:loop` against the three-item selector so it
   compiles a contract with items A, B (disjoint ownership, no dependencies) and C (conflicting
   with A), under the `concurrency` run policy. Confirm via `pipeline:loop audit <run-id>` (or
   equivalent) that all three items are `pending` and the contract's `concurrency.max_concurrent`
   is at least 2.

2. **Let the supervisor admit A and B concurrently.** The scheduler selects A and B together (the
   only pair the pairwise evaluator proves independent) and dispatches both into their own,
   separate managed worktrees. Confirm via the audit view:
   - A and B are both `in_progress`,
   - C is still `pending`, and the durable planning record (`loop_schedule_evaluated`) names C's
     disposition as `conflict_edge` (or `unknown_ownership`, depending on the declared conflict
     kind) naming the admitted item (A) it conflicts with,
   - A and B's managed worktrees are distinct filesystem roots.

3. **Confirm independent evidence.** While A and B are both `in_progress`, confirm via the audit
   view or the raw ledger that each item's history, action-evidence, and worktree identity are
   recorded independently — neither item's entries reference the other's worktree, PR, or history.

4. **(Optional) induce a recoverable interruption on one member.** To exercise "a failure of one
   member does not re-drive or invalidate the other's evidence," induce a real recoverable
   condition on only one of A or B (e.g. a transient CI failure or rate limit) and confirm the
   other member's progress continues unaffected, then recover the interrupted member per its
   `DurableBlockerClass` policy (see the #515 runbook's steps 3–4 for the general recovery
   procedure) before continuing.

5. **Induce a mid-run changed-file overlap between A and B.** While both are `in_progress`,
   deliberately have A's and B's real work touch one common file their ownership declarations did
   NOT mark shared (e.g. both branches edit the same generated lockfile or a shared config file
   neither declared). Confirm via the audit view / ledger, once the supervisor's changed-files
   observation seam next runs:
   - both A and B transition to `blocked` with `blocked_theme: "workflow-state"`,
   - a durable replan request (`loop_replan_requested`) is recorded naming the overlapping file
     and both affected item ids,
   - neither item's PR or issue was merged, pushed to, force-updated, or had a label written as
     part of the parking action itself (parking is a ledger-only write).

6. **Resolve the overlap and recover both members.** Resolve the real overlap (e.g. rebase one
   branch off the other, or move the shared file into a declared-shared ownership surface), then
   run the engine's recovery entry point for each of A and B independently (`recoverItem`, via
   whatever `pipeline:loop` CLI surface wraps it) followed by `pipeline:loop resume`. Confirm each
   item's ledger history shows exactly one `blocked -> in_progress` recovery transition and that
   recovering one member recorded no history entry against the other.

7. **Let A and B reach `ready`, and set up the merge barrier.** Once each PR passes checks and
   carries the `pipeline:ready-to-deploy` label, confirm A and B are `ready`. Confirm C is still
   `pending` and, once a merge barrier is set for A's pending merge (see step 8), that C's next
   scheduling pass is denied with disposition `merge_barrier` — not started, even though A and B
   are no longer active.

8. **A human merges A's PR.** This is the one step in the whole run a human performs, never the
   pipeline. Merge A's PR through the normal GitHub UI/CLI.

9. **Resume/observe the merge and let C run.** Run the next reconciliation pass. Confirm:
   - A's ledger state repairs forward from `ready` to `merged` — driven by the reconciliation pass
     observing the merge through the engine-owned seam, never by any caller-supplied claim,
   - the merge barrier clears only once the base branch is verified to contain A's merge commit
     (`loop_merge_barrier_cleared` recorded), and no merge-class operation (a second merge, a base
     refresh, a reconciliation pass affecting another item's terminal state) ran concurrently with
     A's merge,
   - C becomes eligible and is started only on/after that reconciliation cycle,
   - C is driven through its own review and pre-merge gates to `ready` — the scheduler grants it
     no merge authority.

10. **Confirm the run's terminal condition.** Confirm the whole run reports `allDone` (or the
    operator's chosen `done_definition`) with no stop record, and B and C are both `ready` (A
    `merged`).

11. **Capture the evidence bundle** (see contract below) and **link it from issue #531**.

## Evidence-bundle artifact contract

The captured evidence bundle for the live run MUST include, for each of the five exercised
behaviors:

| Behavior | Required artifact |
|---|---|
| Disjoint concurrency with independent evidence | The `loop_schedule_evaluated` record showing A and B both `admitted` in the same pass; each item's distinct managed-worktree path/identity; each item's independently-recorded ledger `history` and action-evidence entries, with no cross-references between A's and B's records. |
| Serialized conflict | The `loop_schedule_evaluated` record's rationale entry for C (disposition `conflict_edge`/`unknown_ownership`, naming the admitted item it conflicts with); C's ledger `state` remaining `pending` while A and B are active. |
| Changed-file-overlap park/replan | The `loop_replan_requested` record naming the overlapping file and both affected item ids; A and B's ledger `history` entries showing their `blocked` (`workflow-state`) transitions; each item's `recovery_attempts` entry recording the recovery outcome (`recovered`). |
| Serialized merge-class integration | The `loop_schedule_evaluated` record denying C with disposition `merge_barrier` while the barrier is set; the `loop_merge_barrier_cleared` record naming A and its merged sha; C's ledger `history` showing its `pending -> in_progress` start occurs no earlier than that clearing event. |
| Evidence reporting | The full set of artifacts above, assembled into one bundle (not a prose summary) referencing the ledger, the action-evidence timeline, the ownership-evaluation record, and the scheduling/replan/barrier events directly. |

The bundle also records the run's terminal condition (all items done, `stop: null`) and the run
id, so a reviewer can independently pull the raw ledger/events/action-evidence for verification.
