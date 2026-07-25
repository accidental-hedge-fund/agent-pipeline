# Design

## Context

Root-cause trace for run `loop-89f17a2190c3f333` cycle 1 (item #502):

1. The supervisor dispatched #502. #502 carried a **stale, reason-less `pipeline:blocked`
   label** — an orphaned audit-repair placeholder from an earlier session — co-present with
   a `pipeline:*` stage label. Per-item execution surfaced the standing blocker, made **0
   stage transitions**, and returned an outcome that normalized to `failed`
   (`ready → ready`, 0 transitions, 4s).
2. In Pass 2's `failed` branch the supervisor consulted the live issue and computed
   `observedStage = pipelineStageFromLabels(labels)`. That helper
   (`core/scripts/loop/precondition.ts`) returns the **first** `pipeline:*` label it finds —
   here the co-present stage label, **not** `blocked`. So #570's `observedStage === "blocked"`
   needs-human safety net did not fire, and the item fell through to
   `blockItem(blockerClass: "workflow-engine-defect")`, whose recovery policy is `run_fatal`.
   The run stopped terminally on #502 (`stop: {reason: run_fatal, item_id: 502, theme:
   workflow-engine-defect, outstanding_ready: []}`).
3. The `outstanding_ready` set was `[]` because the 7 selectable siblings were at a
   pre-`ready` stage, not yet `pipeline:ready-to-deploy` — so #570's disclosure (which scopes
   to `ready`) correctly reported none, but the run had nonetheless terminated with 7 clean
   items still schedulable.

The observable defect is two-fold and the two parts are independent:

- **(A) Detection blind spot.** An already-`blocked` item is only recognized as
  needs-human when `blocked` happens to be the single stage-winner of
  `pipelineStageFromLabels`. A `pipeline:blocked` label co-present with any other
  `pipeline:*` stage label is missed.
- **(B) Whole-run halt on one hold.** Even a correctly-routed hold would, under the
  supervisor's cycle-start `held` short-circuit, terminate the entire run — because
  `durable-loop-supervisor` treats *an outstanding paused/waiting hold* as a terminal
  condition unconditionally. The 7 selectable siblings were stranded.

This is the third sibling of the Pass-2 catch-all family: #568 fixed the *pre-pipeline
no-op* case, #570 the *needs-human/retryable blocker* case, and #581 fixes the
*already-blocked (co-present label) + run-continuation* case.

## Decision 1 — Detect `pipeline:blocked` by presence, not by stage-winner

`pipelineStageFromLabels` is the single-source primitive that both reconciliation and the
Pass-2 safety net use to answer "what pipeline stage is this item at?" — a
**single-winner** derivation (first `pipeline:*` label). That is correct for a *stage*
question but wrong for a *blocked?* question: `pipeline:blocked` is a cross-cutting
disposition that can co-exist with a stage label (a stale/orphaned blocker layered over the
item's last stage). Overloading the single-winner helper to answer both defeats detection
whenever another `pipeline:*` label sorts ahead of `blocked`.

We add a small, dedicated **presence predicate** — "does this item's live label set contain
`pipeline:blocked`?" — alongside `pipelineStageFromLabels`, and route the Pass-2 needs-human
net off the predicate instead of `observedStage === "blocked"`. We do **not** change
`pipelineStageFromLabels`: reconciliation's stage projection and the precondition gate must
keep their single-winner semantics (an item's *stage* is still one value). The predicate is
a pure function of the observed live labels, injected through the same `observe` seam #570
already uses, so a unit test drives it with no real network/git/subprocess call and no new
`gh` field shape is introduced (CLAUDE.md golden rule #5).

**Stale / reason-less blockers need no special case.** The disposition for a
`pipeline:blocked` label is a needs-human hold regardless of whether a recoverable reason
was recorded: the standard operator remediation is identical — a human clears the label
(`pipeline unblock` or a manual removal) and the run resumes. A reason-less placeholder is
just a `pipeline:blocked` label with an empty reason; the presence predicate treats it the
same, which is exactly the observed remediation for #502.

**Zero-transition guard is retained.** As in #568/#570, the net only fires when the dispatch
made no stage transition (diffed against the pre-dispatch GitHub-authored label-add history,
not a local clock). A dispatch that genuinely advanced the item and *then* left it at
`pipeline:blocked` is a real in-flight blocker handled by the normal transition path; the
already-blocked case (#581) is specifically the **no-op** dispatch against a standing label.

## Decision 2 — A per-item hold excludes the item from the frontier; it does not halt the run

Root cause B lives in `durable-loop-supervisor`: the run's terminal conditions include *an
outstanding paused/waiting hold*, and the supervisor's cycle-start `held` short-circuit
returns immediately when **any** item is `paused`/`waiting`. That was acceptable for #570's
scenarios — the only siblings there were at `ready` (terminal, non-schedulable), so pausing
lost nothing — but it is wrong the moment a *schedulable* sibling exists.

We refine the hold to behave like the precondition exclusion (#568): a held item is
**excluded from the executable frontier** each cycle and re-evaluated against the fresh
reconciliation (still held vs. cleared by a human), while the run continues selecting and
dispatching the remaining schedulable items. The run reaches its terminal outstanding-hold
condition — pausing and reporting `hold_outstanding=true` — **only when no non-done item can
make progress**: every remaining item is either held or blocked and no schedulable item
remains. This composes with, and does not weaken, the existing no-progress watchdog: once
the frontier is empty because everything is held, there is no eligible item and the run
reaches its terminal hold rather than spinning.

**The terminal hold enumerates every held item.** Mirroring #570's `outstanding_ready`
disclosure, when the run reaches the terminal outstanding-hold condition it enumerates every
held item id in both the durable record and the `pipeline loop` CLI output, so an operator
sees exactly which items await a human. This is additive disclosure on the existing terminal
condition — it introduces no new stop reason and does not change which items are done.

**Why not a retry-budgeted class instead of a hold.** As argued in #570, a retry-budgeted
class would re-dispatch the item while `pipeline:blocked` still stands, immediately
re-blocking on the same standing label — burning budget without progress. The hold is the
correct semantics: a deliberate, non-terminal, human-resolved pause on *that item only*.

## Decision 3 — Relationship to #570 and #568

- #570's `outstanding_ready` disclosure is unchanged and still fires on every terminal stop;
  #581 adds the parallel disclosure of held items on the terminal outstanding-hold
  condition. The two are complementary (ready = merge-ready-but-unmerged; held =
  awaiting-human-unblock).
- #570's requirement text said a needs-human hold makes the run "pause". #581 refines that
  consequence: the run pauses on a hold only when no other item can make progress; otherwise
  it continues. #570's own scenarios (a hold alongside a `ready`, i.e. non-schedulable,
  sibling) remain valid — a `ready` sibling is not schedulable, so the run still pauses
  there. We surface this refinement as a MODIFIED delta rather than leaving the older
  "pauses" text to contradict the new continuation behavior.
- #568's precondition exclusion is the structural template for the held-item frontier
  exclusion (non-terminal, re-evaluated each cycle, never a `blocked` transition, never
  run-fatal).

Ordering within Pass 2's `failed` branch is unchanged in intent: (1) genuine crash/rejection
→ `workflow-engine-defect`; (2) #568 precondition no-op → non-fatal exclusion; (3)
`pipeline:blocked` **present** (Decision 1) → needs-human hold; (4) otherwise →
`workflow-engine-defect` / `run_fatal`. Only guard (3)'s predicate changes (presence vs.
stage-winner); each guard remains mutually exclusive on the observed state.

## Non-goals / boundaries

- No auto-merge and no auto-unblock: the pipeline still stops at
  `pipeline:ready-to-deploy`, and a human still owns both the merge and the clearing of a
  `pipeline:blocked` label (CLAUDE.md golden rule #4). The hold pauses *for* the human.
- No change to the `DurableBlockerClass` enum, the genuine-defect `workflow-engine-defect`
  / `run_fatal` policy, the `paused`/`waiting` hold semantics in
  `durable-pause-and-authority`, or `pipelineStageFromLabels`'s single-winner stage
  derivation.
- Single-host concurrency scope is unchanged (#459): these are host-local run-state
  transitions, not a new cross-host artifact.
