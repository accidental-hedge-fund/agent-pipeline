## Context

The planning stage (`planningStage.advance()` in `core/scripts/stages/planning.ts`) owns the
entire `ready → review-1` arc: plan → plan-review → plan revision → implement → open PR →
transition to `review-1`. It sets a repo-stable live-planning marker
(`/tmp/pipeline-planning-<owner>-<repo>-<N>.live`, PID-stamped) at the top of `advance()` and
clears it in a `finally` block, so the marker is held for the whole arc — including the window
after the `pipeline:implementing` label is written and while the implementation harness runs.

Re-entry at `implementing` is handled by `dispatchResume()` (#175). Its current shape:

```ts
const wt = await getWt(cfg, issueNumber);
if (!wt || !(await commitsAhead(wt.path, cfg.base_branch))) {
  return {
    advanced: false,
    status: "waiting",
    reason: "implementing is set mid-flight by the planning/plan-review handler; nothing to do at this point.",
  };
}
// ... resume: gate → push → PR → review-1
```

This conflates two very different states behind one `waiting` return:

1. **Live mid-flight** — a concurrent process (same repo, possibly different domain/worktree)
   is actively implementing and hasn't committed yet. Waiting is correct.
2. **Crash-stranded, no commits** — the run that set `implementing` died before committing.
   Waiting is wrong: nothing will ever advance the issue, and the run exits 0, so the stall
   is invisible to orchestrators. Manual `pipeline triage N --stage plan-review`/`ready` is
   the only recovery today.

The `planning` / `plan-review` dispatch already resolves the same ambiguity via the
live-planning marker (`planning-crash-recovery` / #271): live marker → `waiting`; absent/dead
marker → roll back to `ready` and restart. This change applies the identical pattern to the
`implementing` entry, while preserving the #175 resume-with-commits path for the crash case
that *did* leave committed work behind.

## Goals / Non-Goals

**Goals:**
- Make a crash-stranded `implementing` issue self-heal on the next `/pipeline N`, with no
  manual label rewind.
- Reuse the existing live-planning marker as the single liveness signal — no new marker,
  heartbeat, or run-lock file.
- Preserve the #175 resume path exactly for crashes that left commits in the worktree.
- Never resume-race a live cross-domain implementer.
- Keep the change surgical: modify `dispatchResume()` ordering + add one recovery branch;
  thread the existing `PlanningRecoveryDeps` seam through so it is unit-testable.

**Non-Goals:**
- Resuming a partial *uncommitted* implementation. A crash that left no commits is restarted
  from scratch; there is no half-implemented artifact worth salvaging (the uncommitted-work
  salvage pre-pass, #131, only applies once the implement harness has run within a live run).
- Changing the exit code of a legitimate concurrent-wait outcome (see the decision below).
- Introducing a new run-lock or heartbeat mechanism. The live-planning marker already covers
  the entire arc including `implementing`; adding a second signal would duplicate it and
  create a new cleanup failure mode.
- Touching the `planning` / `plan-review` recovery — that path is unchanged.

## Decisions

**Decision: liveness (marker) check first, commits check second.**
The marker is the authoritative "is anyone alive on this issue" signal for the whole arc. If
the marker is live, we must not inspect or act on the worktree at all — a live implementer may
be mid-commit, and running the test gate / pushing / opening a PR against its worktree is a
race. So the order is: (1) live marker → `waiting`; (2) dead/absent marker + commits ahead →
resume (#175); (3) dead/absent marker + no commits → restart from `ready`. This ordering is a
strict improvement over #175, which inspected the worktree first with no liveness gate.

**Decision: reuse `planningStage.advance()` + `transition()` for the restart, rolling back to
`ready` first.** `advance()` performs the `ready → planning` transition internally, so the
issue must be on `ready` before it is called. Rolling `implementing → ready` first keeps the
planning handler's contract intact and reuses the exact recovery primitive the
`planning`/`plan-review` path already uses — no second code path. The recovery therefore also
inherits the marker's `finally`-cleanup and worktree-lookup/recreation logic for free.

**Decision: restart from scratch, do not resume a no-commit worktree.** A worktree with zero
commits ahead of base carries no implementation to preserve. Re-running the planning arc is
idempotent (it re-plans, re-reviews, re-implements) and consistent with the `planning` /
`plan-review` recovery. Distinguishing "crashed just after the label write" from "crashed
after a dirty-but-uncommitted edit" is not worth the complexity: the restart is safe for both.

**Decision: thread `PlanningRecoveryDeps` (marker + `transition` + `planningAdvance`) into
`dispatchResume`.** `dispatchResume` already has a `DispatchResumeDeps` seam for the resume
path (`getForIssue` / `hasCommitsAhead` / `getIssueDetail` / `resumeFromImplementing`). The
recovery branch needs `isLivePlanningActive`, `transition`, and `planningStage.advance` to be
fakeable so unit tests do no real `gh`, git, or subprocess work. The `implementing` case in
`dispatch()` (pipeline-run.ts) already constructs `realPlanningRecoveryDeps()` for the
`planning` / `plan-review` cases; pass the same object through to `dispatchResume`. This keeps
one recovery-deps seam across all three crash-recovery entry points.

**Decision: keep exit code 0 for the residual `waiting` (live owner) — no WARNING / non-zero
exit.** The issue asked whether a `waiting` "nothing to do" should exit non-zero or warn so a
stall does not look healthy. After this change, the *only* remaining `waiting` at
`implementing` is the genuinely-live case: another process owns the marker and will finish the
arc. That is a healthy concurrent wait, not a stall — exiting 0 is correct, and a non-zero
exit would make orchestrators treat a normal concurrent run as a failure. The invisible
*permanent* stall the issue reported is eliminated by the recovery itself, not by the exit
code. The one concrete improvement kept from that suggestion is making the residual `waiting`
reason name the live owner, so the outcome is self-describing rather than the ambiguous
"nothing to do at this point." This is a rigor-preserving change, not a latency shortcut.

## Risks / Trade-offs

- *A live implementer whose marker was somehow cleared early* — the marker's `finally` clears
  only on `advance()` return/throw, i.e. when the arc is truly over. A live, mid-implement run
  still holds the marker, so it cannot be misclassified as crash-stranded. Risk: negligible,
  and identical to the risk already accepted for the `planning` / `plan-review` recovery.
- *Backward transition `implementing → ready`* — `transition()` validates the target is a
  recognized stage but does not enforce forward-only ordering; backward transitions are
  already used by `triage --stage` and the `planning` / `plan-review` recovery. Confirmed safe.
- *No-commit worktree left on disk from the crashed run* — `planningStage.advance()` reuses
  the existing worktree via its lookup/recreation logic; no cleanup is required here.
- *Race between the marker liveness probe and a run that acquires the marker microseconds
  later* — the per-issue domain lock plus the marker's PID-probe make this the same
  already-accepted TOCTOU window as the `planning` recovery; the loser of the race simply
  re-observes the state on the next tick. No new failure mode introduced.
