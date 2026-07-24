# Design

## Context

Root-cause trace for run `loop-07d05fcd68f7db98` cycle 2 (item #536):

1. Per-item execution ran the advance loop for #536. Plan-review's revision-output
   contract (`verifyPlanRevisionOutput`, `core/scripts/verify-harness-commits.ts`) failed
   with `Plan revision output is missing required ## Feedback Incorporated section`.
   `planning.ts` calls `setBlocked(..., "plan-review", "needs-human")`, which adds the
   `pipeline:blocked` label and posts the attested blocker comment. This is a **recoverable
   needs-human hold**: the standard operator remediation is `pipeline unblock` + re-run.
2. Back in the supervisor, the dispatch-outcome mapping normalized the item to `failed`
   (the run stopped at a `pipeline:blocked`/plan-review state rather than a clean
   `ready`/`closed`), and Pass 2's catch-all mapped `failed` →
   `blockItem(blockerClass: "workflow-engine-defect")`, whose recovery policy is
   `run_fatal`. The run stopped terminally on #536.
3. The terminal stop record (`{reason: run_fatal, item_id: 536, theme:
   workflow-engine-defect}`) carried no reference to item #535, which was sitting at
   `ready` with PR #569 open and unmerged. The `pipeline loop` CLI output likewise did not
   name it.

The observable defect is two-fold: (a) a recoverable needs-human pipeline blocker is
treated as a fatal engine defect, and (b) the resulting stop silently strands an
outstanding ready-to-deploy item.

This is the direct sibling of #568 (`loop-precondition-stage-gate`), which fixed the same
Pass-2 misclassification for the *pre-pipeline no-op* case. #570 is the *needs-human /
retryable blocker* case of the same catch-all.

## Decision 1 — A needs-human pipeline blocker is a hold, not a blocker class

Issue #570's acceptance criterion allows two dispositions for a needs-human blocker: a
needs-human **hold** (`hold_outstanding=true`) or a **retry-budgeted class**. We choose the
hold as the primary disposition.

**Why the hold, not a retry-budgeted class.** The standard remediation is "unblock +
re-run": a human clears the `pipeline:blocked` label (answering/curing the blocker), then
the run resumes. A retry-budgeted class would auto-re-dispatch the item *while the
`pipeline:blocked` label still stands*, so the advance loop would immediately re-block on
the same condition — burning budget without progress until it exhausts into another
terminal stop. The pause/hold path (`pauseItem` / `waitItem` in `loop/pause.ts`) models
exactly the intended semantics: a non-terminal, deliberate hold that a human resolves and
the run resumes from. It sets `hold_outstanding=true`, pauses (not stops) the run, and — by
design of `runSupervisorCycle`'s `held` short-circuit — preserves every sibling's state,
including a `ready` sibling.

**Why not the existing `blocked_needs_human` → `missing-authority` routing.** Pass 2 today
maps `blocked_needs_human` to `classifyAndBlockItem(candidateClasses:
["missing-authority"])`. `missing-authority` is a `human_authority`/`run_fatal` class whose
purpose is to reinforce the engine's merge/release/credential/deploy authority gates — a
category error for a plan-review format flake, and it records a **terminal stop**, not a
hold. We reroute `blocked_needs_human` to the pause path so a recoverable, human-unblockable
pipeline blocker produces `hold_outstanding=true` rather than a terminal stop.

## Decision 2 — Classify on live truth, defense-in-depth like #568

The primary fix is at the outcome-mapping boundary: `blocked_needs_human` → hold. But the
#570 trace shows the item reached Pass 2 as `failed`, not `blocked_needs_human` — the
`failed` catch-all is the actual trap. So, exactly as #568 added a *precondition no-op*
safety net before the `workflow-engine-defect` classification, we add a *needs-human
blocker* safety net in the same place:

- Before classifying a `failed` outcome as `workflow-engine-defect`, and after the existing
  #568 precondition no-op check, consult the live issue through the existing `observe`
  seam. If the issue carries `pipeline:blocked` (a recoverable, human-unblockable
  disposition) and the dispatch did not crash/reject, treat the outcome as
  `blocked_needs_human` → needs-human hold (Decision 1).
- A rejected/crashed dispatch never has a live `pipeline:blocked` state to observe (or its
  observation itself failed), so it falls through to the genuine-defect classification
  unchanged. An unrecognized terminal outcome with the item at no `pipeline:blocked` state
  likewise remains `workflow-engine-defect` / `run_fatal`.

The check is a deterministic function of the observed live labels, injected via the same
seam #568 uses, so a unit test drives it with no real network, git, or subprocess call. It
reuses the same label observation the facade already relies on — no new gh field shape is
introduced (CLAUDE.md golden rule #5).

Ordering within Pass 2's `failed` branch: (1) genuine crash/rejection → defect; (2) #568
precondition no-op → non-fatal exclusion; (3) `pipeline:blocked` → needs-human hold; (4)
otherwise → `workflow-engine-defect` / `run_fatal`. Each guard is mutually exclusive on the
observed state, so the ordering only fixes precedence for clarity.

## Decision 3 — A stop discloses outstanding ready items

The second defect — a stop silently stranding item #535 at `ready` — is independent of the
misclassification and applies to **every** terminal stop, not just this one. So the
disclosure is a property of the stop record itself, not of one classification path.

- `LoopStopRecord` gains an `outstanding_ready: string[]` field. At the moment any terminal
  stop is recorded, the field is populated from the ledger's items currently in the `ready`
  state (`pipeline:ready-to-deploy`, awaiting the human merge the pipeline never performs).
- The `pipeline loop` CLI result JSON includes those ready ids whenever a stop is reported,
  so an operator sees "the run stopped, and these ready-to-deploy PRs are still open."
- This composes with, and does not weaken, the existing stop reasons or the auto-file hook
  (`durable-run-blocker-auto-file`, #538): disclosure is additive metadata on the stop, not
  a new terminal condition.

We deliberately scope disclosure to the `ready` state (the pipeline's terminal,
human-owned state) rather than all non-done items: `ready` is the state whose silent
stranding actually loses a human-actionable, merge-ready artifact. In-progress/blocked/
pending items are already reflected by the run's normal status projection.

## Non-goals / boundaries

- No auto-merge and no auto-unblock: the pipeline still stops at
  `pipeline:ready-to-deploy`, and a human still owns both the merge and the unblock
  (CLAUDE.md golden rule #4). The hold *pauses for* the human; it does not act for them.
- No change to the `DurableBlockerClass` enum, to the genuine-defect
  `workflow-engine-defect` / `run_fatal` policy, or to the `missing-authority` /
  `specification-decision` human-authority classes (which remain the correct disposition
  for real authority/credential gates).
- Single-host concurrency scope is unchanged (#459): these are host-local run-state
  transitions, not a new cross-host artifact.
