## Why

`auto_recovery_max_retries` only covers the implementation stage (`tryAutoRecover`, driven from
`pipeline:implementing` + `blocked` with no commits ahead). A **fix-stage** harness crash gets no
recovery attempt at all: in `advanceFix`, `if (!result.success)` immediately calls `setBlocked(...)`
and returns `fixHarnessFailureOutcome(reason)` (`core/scripts/stages/fix.ts`).

Observed on PraxisIQ/fuseiq-core#95 (run `95/2026-07-21T14:28:46Z`, stage `fix-2`, v1.16.0): the
claude harness died with `exit 1` after ~13 minutes of a 40-minute `fix_timeout` budget, mid-way
through a *correct* fix. The worktree held an uncommitted, near-complete diff (service change plus a
186-line regression test) whose narration ended at "run the new test". The run blocked with
`human_intervention kind=reviewer-unavailable, detail="exit 1"` and a human had to inspect the
worktree, finish the draft, commit, and unblock. $2.47 of correct work became a human-intervention
block over a transient CLI failure.

Note the existing salvage path (`harness-uncommitted-salvage`) does **not** help here: it only runs
after a *successful* harness exit that produced no commit. A crashed harness never reaches it.

## What Changes

- `core/scripts/stages/fix.ts`: replace the single-shot `!result.success` block with a bounded retry
  loop around the fix-harness invocation, capped at `cfg.auto_recovery_max_retries`.
- Retries fire only for a **crash** — a non-zero process exit that is not a timeout. A timeout
  (`result.timed_out`) means the stage budget was consumed and keeps today's immediate block.
- Each retry is invoked with the **remaining** stage budget (`fix_timeout` minus elapsed wall-clock
  across prior attempts). When the remaining budget falls below a small floor, no further retry is
  attempted and the stage blocks.
- The retry prompt is the round's normal fix prompt plus a **resumption preamble** injected when the
  worktree is dirty: it states that uncommitted in-progress work from the crashed attempt exists,
  lists the changed paths, and instructs the harness to review and complete that work rather than
  discard or restart it.
- The recovery path performs **no** destructive git operation: no `git reset`, `git restore`,
  `git checkout --`, `git clean`, and no worktree removal.
- Every attempt and its outcome is recorded: a `fix_harness_recovery` event appended to
  `events.jsonl` and a `RecoveryRecord` (`trigger: "fix-harness-crash"`) appended to the evidence
  bundle. Per-attempt cost accounting is emitted exactly as for a single attempt today.
- On exhausted retries the stage blocks exactly as today (`setBlocked(..., "harness-failure")` +
  `fixHarnessFailureOutcome`), with the reason naming the attempt count.
- New injectable `FixCrashRecoveryDeps` seam (clock + worktree status + invoke) so unit tests cover
  the loop with no real subprocess, git, or network calls.

## Capabilities

### New Capabilities
- `fix-harness-crash-recovery`: bounded, budget-aware, work-preserving retry of a crashed fix-stage
  harness, with recorded attempts and an unchanged exhaustion block.

### Modified Capabilities
- (none — `harness-uncommitted-salvage`, `review-sha-gating`, and the fix round's downstream gates
  are unchanged; recovery happens strictly before the existing post-harness path.)

## Impact

- `core/scripts/stages/fix.ts` — retry loop, resumption-preamble construction, `FixCrashRecoveryDeps`.
- `core/scripts/prompts/fix.md` (or a sibling prompt fragment) — the resumption preamble text.
- `core/scripts/run-store.ts` / `core/scripts/types.ts` — additive `fix_harness_recovery` event type.
- `core/test/fix*.test.ts` — regression + unit coverage for the loop.
- `plugin/` — regenerated mirror.
- No config-schema key is added: the existing `auto_recovery_max_retries` governs the cap.
- Out of scope: review-stage harness hangs (#398) and reviewer spawn crashes (#393).

## Acceptance Criteria

- [ ] A fix-stage harness that exits non-zero **without** timing out is re-invoked, up to
      `cfg.auto_recovery_max_retries` additional attempts, before the stage blocks.
- [ ] A fix-stage harness that **times out** is NOT retried; it blocks immediately with today's
      `timed out after Ns` reason and `blockerKind: "harness-failure"`.
- [ ] Each retry is invoked with `timeoutSec` equal to the remaining stage budget
      (`cfg.fix_timeout` minus elapsed wall-clock across previous attempts), never the full budget.
- [ ] When the remaining stage budget is below the minimum-retry floor, no retry is invoked and the
      stage blocks with a reason naming budget exhaustion.
- [ ] When the worktree is dirty at retry time, the retry prompt contains a resumption preamble that
      (a) states uncommitted in-progress work from the crashed attempt exists, (b) lists the changed
      paths, and (c) instructs the harness to review/complete rather than discard or restart it.
- [ ] When the worktree is clean at retry time, the retry prompt is byte-identical to the first
      attempt's prompt (no preamble).
- [ ] The recovery path issues no `git reset`, `git restore`, `git checkout --`, or `git clean`
      command and does not remove the worktree; uncommitted work present before a retry is still
      present after it.
- [ ] Each attempt appends a `fix_harness_recovery` event to `events.jsonl` carrying the stage,
      attempt number, cap, exit code, and remaining budget.
- [ ] Each recovery attempt appends a `RecoveryRecord` with `trigger: "fix-harness-crash"` to the
      evidence bundle, and it is rendered in the bundle summary.
- [ ] After the retry cap is exhausted, the stage blocks with `blockerKind: "harness-failure"` and an
      outcome shape identical to today's, with the reason naming the number of attempts made.
- [ ] A retry that succeeds continues into the existing post-harness path (salvage → commit gates →
      format/test gates → advance) with no behavior change.
- [ ] Unit tests exercise the loop through the `FixCrashRecoveryDeps` seam with no real subprocess,
      git, or network calls, and a regression test bites (fails without the retry loop).
- [ ] `npm run ci` passes, including the regenerated `plugin/` mirror check.
