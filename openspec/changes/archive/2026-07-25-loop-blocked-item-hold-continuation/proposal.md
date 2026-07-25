## Why

Launching the v1.28.0 lane on the hardened supervisor (run `loop-89f17a2190c3f333`,
2026-07-25) surfaced the **third** variant of the same Pass-2 misclassification family —
after #568 (a pre-pipeline `backlog` no-op read as a defect) and #570 (a needs-human
plan-review blocker read as a defect). This time the supervisor dispatched #502 first;
#502 carried a **stale, reason-less `pipeline:blocked` label** — an orphaned audit-repair
placeholder from an earlier session ("original block reason could not be recovered").
Dispatch immediately surfaced the standing blocker, made **0 transitions**
(`ready → ready`), and the supervisor classified the outcome
`workflow-engine-defect` / `run_fatal`, **terminally stopping the entire run** — even
though 7 other clean, ready-to-schedule items were selectable.

Two independent defects combine to produce this:

1. **The needs-human detection has a co-present-label blind spot.** #570's safety net keys
   off `pipelineStageFromLabels(labels) === "blocked"`, and that helper returns only the
   *first* `pipeline:*` label it finds. #502 carried `pipeline:blocked` **alongside** a
   pipeline stage label, so the helper returned the stage label — not `blocked` — and the
   `observedStage === "blocked"` net never fired. The `failed` catch-all then classified
   the item `workflow-engine-defect`, whose default policy is `run_fatal`. An already-
   `blocked` item observed on live truth is exactly the recoverable, human-unblockable
   disposition #570 defined a hold for; it must not depend on `blocked` being the single
   stage-winner.
2. **Any single hold halts the whole run.** Even had the item been correctly routed to a
   needs-human hold, the supervisor treats *an outstanding paused/waiting hold* as a
   terminal condition (the cycle-start `held` short-circuit): the first held item pauses
   the entire run, stranding the 7 selectable siblings. The run should continue on the
   remaining schedulable items and only stop when **no** item can make progress.

The #570 remediation is active — the terminal stop now includes `outstanding_ready` (it was
`[]` here because the strandable items were pre-`ready`, not yet at `ready-to-deploy`) —
but that discloses stranded work; it does not prevent the premature terminal stop.

## What Changes

- **An already-`blocked` dispatched item becomes a per-item needs-human hold, never a
  run-fatal engine defect.** When a dispatched item is observed on live truth carrying the
  `pipeline:blocked` label — detected by the label's **presence** in the item's label set,
  independent of any co-present `pipeline:*` stage label and independent of whether the
  blocker carries a recoverable reason — and the dispatch made no stage transition and did
  not crash or reject, the supervisor SHALL record a per-item needs-human hold rather than
  classifying the outcome `workflow-engine-defect` / `run_fatal`. This closes the
  co-present-label blind spot in #570's `observedStage === "blocked"` net and extends the
  needs-human disposition to a stale/reason-less standing blocker (whose remediation is
  identical: a human clears the `pipeline:blocked` label and the run resumes).
- **A per-item hold no longer halts a run that still has schedulable work.** An item held
  for a needs-human blocker SHALL be excluded from the executable frontier each cycle —
  the same non-terminal, re-evaluated-each-cycle exclusion the precondition gate (#568)
  already applies — while the run continues dispatching the remaining schedulable items.
  The run SHALL reach its terminal outstanding-hold condition only when **no** non-done
  item can make progress (every remaining item held or blocked), and that terminal report
  SHALL enumerate every held item so an operator sees exactly which items await a human.
- **No genuine-defect regression, no new authority.** A rejected or crashed dispatch, or an
  unrecognized terminal outcome with the item at no `pipeline:blocked` state, remains
  `workflow-engine-defect` / `run_fatal`. The pipeline still stops at
  `pipeline:ready-to-deploy`; a human still owns both the merge and the unblock — the hold
  pauses *for* the human, it does not act for them.

## Acceptance criteria

- [ ] A dispatched item observed on live truth carrying `pipeline:blocked` — including when
      that label is co-present with a `pipeline:*` stage label, and including a stale,
      reason-less blocker — that makes 0 stage transitions and neither crashes nor rejects
      is recorded as a per-item needs-human hold, NEVER classified `workflow-engine-defect`
      and NEVER recording a `run_fatal` (or `human_authority`) run stop.
- [ ] Detection of the `pipeline:blocked` disposition uses the label's presence in the
      item's live label set, not whether `pipelineStageFromLabels` returns `blocked` as the
      single stage-winner, so a `pipeline:blocked` label co-present with any other
      `pipeline:*` stage label is still detected.
- [ ] A per-item needs-human hold does NOT by itself terminate the run: while at least one
      other item can make progress, the run continues dispatching the remaining schedulable
      items, and the held item is re-evaluated (still held vs. cleared) each cycle.
- [ ] The run reaches its terminal outstanding-hold condition only when no non-done item can
      make progress (every remaining item held or blocked); that terminal report enumerates
      every held item id, in both the durable record and the `pipeline loop` CLI output.
- [ ] A genuine engine defect — a rejected/crashed dispatch, or an unrecognized terminal
      outcome with the item at no `pipeline:blocked` state — is still classified
      `workflow-engine-defect` with its `run_fatal` policy intact.
- [ ] Regression test: a work-list of one already-`pipeline:blocked` item + N clean items
      dispatches the N clean items to their outcomes and holds the blocked one; the run does
      NOT `run_fatal`. The test bites — it fails on the pre-fix classification of the blocked
      item as `workflow-engine-defect` / `run_fatal` and on the pre-fix whole-run pause after
      the first hold.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install smoke,
      `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-blocked-item-hold-continuation`: a dispatched item observed carrying
  `pipeline:blocked` (presence-detected, co-present stage label and stale/reason-less
  blocker included) with no stage transition and no crash/reject is recorded as a per-item
  needs-human hold, never `workflow-engine-defect` / `run_fatal`; and a per-item hold does
  not terminate a run that still has schedulable work — the run continues on the remaining
  schedulable items and reaches its terminal outstanding-hold condition, enumerating every
  held item, only when no non-done item can make progress.

### Modified Capabilities

- `durable-loop-supervisor`: the "drive a compiled run to a terminal condition" requirement
  is refined so that *an outstanding paused/waiting hold* is a terminal condition only when
  no other item can make progress — a held item alongside a schedulable item does not halt
  the run.
- `loop-needs-human-blocker-disposition`: the needs-human-hold requirement's "and pauses"
  consequence is refined so the run pauses on a hold only when no other item can make
  progress; otherwise it continues with the remaining schedulable items (and the detection
  is broadened to presence of `pipeline:blocked`, closing the co-present-stage-label gap).

## Impact

- `core/scripts/loop/precondition.ts` — a presence-based `pipeline:blocked` predicate over a
  live label set (`labels.includes(pipeline:blocked)`), distinct from the single-winner
  `pipelineStageFromLabels`, so a `pipeline:blocked` label co-present with a stage label is
  detected. The single-source stage helper is unchanged.
- `core/scripts/loop/supervisor.ts` — Pass 2's needs-human safety net uses the presence
  predicate instead of `observedStage === "blocked"`; and the cycle-start `held`
  short-circuit no longer halts the run outright — held items are excluded from the frontier
  (like precondition exclusions) and the run continues, reaching its terminal outstanding-
  hold condition (enumerating every held item) only when no schedulable item remains.
- `core/scripts/pipeline.ts` — the `pipeline loop` result surface names every held item when
  the run reaches the terminal outstanding-hold condition.
- No change to the `DurableBlockerClass` enum, the `run_fatal` policy for genuine engine
  defects, the pause/authority hold semantics, or the pipeline's never-merge boundary.
