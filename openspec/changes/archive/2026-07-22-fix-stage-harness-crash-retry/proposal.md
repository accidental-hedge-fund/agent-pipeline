# Fix-stage harness crash retry with preserved worktree work (#486)

## Why

A fix-stage harness that dies mid-work (exit 1 / non-zero, not a structured failure verdict)
gets **no recovery attempt at all**. `core/scripts/stages/fix.ts` blocks immediately:

```ts
if (!result.success) {
  const reason = result.timed_out ? `timed out after …` : `exit ${result.exit_code}`;
  await setBlocked(cfg, issueNumber, `Fix harness (${harness}) failed: ${reason}`, stage, "harness-failure");
  return fixHarnessFailureOutcome(reason);
}
```

The existing `auto_recovery_max_retries` path (`stages/auto_recover.ts`, dispatched from
`pipeline-run.ts` only when `stage === "implementing"`) does not apply here, and it is the
wrong shape for a fix round anyway: it calls `removeWorktree(...)` — i.e. it *destroys* the
in-progress work.

Observed harm (PraxisIQ/fuseiq-core#95, run `95/2026-07-21T14:28:46Z`, stage `fix-2`, engine
v1.16.0): the claude harness died with `exit 1` after ~13 minutes of a 40-minute `fix_timeout`
budget, ~$2.47 spent, leaving an uncommitted, ~90%-correct diff in the worktree (service change
+ 186-line regression test — the very test that later caught its own deadlock). The run blocked
with `human_intervention kind=reviewer-unavailable, detail="exit 1"`, and a human had to open
the worktree, finish the draft, commit and unblock. The blocker comment gave **no hint that the
work existed**.

Note that the crash path also skips the `#131` salvage call (`trySalvageUncommittedWork`), which
today only runs on the success-but-no-commit path further down the stage.

## Conflict noted (issue body vs. human comment)

The issue body describes a **harness crash** (`exit 1`). The later human comment on #486 reports
a **different root cause with the same operator harm**: fuseiq-core#101 `fix-2` where the stage
reported `outcome: success` in 313s, but the fix agent launched the test suite as a *background*
task and ended its single-turn invocation with work staged (`git add` done) and never committed —
the no-commit guard correctly blocked, but again the blocker message did not reveal that four
verified files sat staged in the worktree.

These are not averaged into one mechanism. This change treats the crash retry as the primary
scope (the issue's stated acceptance criteria), and additionally adopts the comment's two
suggestions, which are cheap and serve the same outcome — *in-progress work is never silently
stranded*: single-turn discipline in the fix/implement prompts, and a worktree-state disclosure
in the blocker comment.

## What Changes

- **In-stage crash retry.** When a fix-round harness invocation fails (non-zero exit, including a
  crash and a timeout), `advanceFix` re-invokes it in the **same worktree**, up to
  `auto_recovery_max_retries` times, before falling through to today's block. No new config key.
- **Remaining-budget honoring.** Each retry's `timeoutSec` is the remaining `fix_timeout` budget
  for the stage (wall-clock already consumed by prior attempts subtracted). When the remaining
  budget is below a usable floor, the pipeline blocks instead of starting a doomed retry.
- **Work-preserving by construction.** The retry path never runs `removeWorktree`, `git reset`,
  `git checkout -- .`, `git clean`, or `git restore` on working-tree content. The crashed
  attempt's uncommitted diff is exactly what the retry inherits.
- **Retry prompt addendum.** A retried invocation gets an explicit preamble telling the harness
  that a previous attempt crashed mid-work, that its uncommitted changes are present in the
  worktree, and that it must review and *complete* them rather than restart or discard.
- **Salvage on exhaustion.** Before the terminal harness-failure block, the pipeline attempts the
  existing `trySalvageUncommittedWork` so a near-complete crashed diff still flows through the
  normal downstream gates instead of being abandoned.
- **Observability.** Each retry attempt and its outcome is appended to `events.jsonl` and recorded
  in the evidence bundle. Exhausted retries block exactly as today (`blockerKind:
  "harness-failure"`, `human_intervention kind=reviewer-unavailable`).
- **Blocker worktree disclosure.** Fix-stage `harness-failure` and `no-commits` blocker comments
  include a `git status --short`-derived summary (staged / unstaged / untracked counts and a
  bounded file list) so an operator can see immediately that recoverable work exists.
- **Single-turn prompt discipline.** `fix.md` and `implementing.md` state that the invocation is
  single-turn: the harness must not end its turn while required work (commit/push) depends on a
  background task; it must wait synchronously.

## Acceptance criteria

- [ ] A fix-stage harness invocation that exits non-zero triggers up to
      `auto_recovery_max_retries` re-invocations in the same worktree before the stage blocks;
      with `auto_recovery_max_retries: 2` a persistently-crashing harness is invoked 3 times total.
- [ ] Each retry is invoked with a `timeoutSec` equal to the remaining `fix_timeout` budget
      (total minus wall-clock already consumed by prior attempts of this stage), never the full
      `fix_timeout` again.
- [ ] When the remaining budget is at or below the usable floor, no further retry is invoked and
      the stage blocks with a reason naming budget exhaustion.
- [ ] The retry prompt differs from the first-attempt prompt by an addendum that states a prior
      attempt crashed, that its uncommitted work is present in the worktree, and that the harness
      must review/complete rather than discard or restart it.
- [ ] No code path in the retry loop invokes `removeWorktree`, `git reset`, `git checkout --`,
      `git clean`, or working-tree `git restore`; a test asserts the worktree/git seams receive no
      such call across a full exhausted-retry sequence.
- [ ] A retry that succeeds and produces a commit advances the round normally (`fix-1 → review-2`,
      `fix-2 → pre-merge`) through the unchanged downstream gates.
- [ ] `events.jsonl` contains one event per retry attempt recording stage, attempt number, limit,
      and the attempt's failure reason; the evidence bundle records the same attempts.
- [ ] After retries are exhausted, the pipeline attempts salvage of uncommitted work; if nothing is
      salvageable it blocks with `blockerKind: "harness-failure"` and the same
      `reviewer-unavailable` intervention as today.
- [ ] A fix-stage `harness-failure` or `no-commits` blocker comment includes a worktree-state
      summary derived from `git status --short` (counts plus a bounded file list), and omits the
      section only when the worktree is clean.
- [ ] `fix.md` and `implementing.md` each contain single-turn discipline text forbidding ending the
      turn with commit/push pending on a background task, drift-guarded by a `prompt-loader.test.ts`
      assertion.
- [ ] Regression tests bite: with the retry loop removed, a crashing-harness test observes exactly
      one invocation and fails.

## Capabilities

### New Capabilities
- `fix-harness-crash-retry`: bounded, worktree-preserving re-invocation of a crashed fix-round
  harness, its retry prompt, budget accounting, observability, and terminal block behavior.
- `blocker-worktree-disclosure`: fix-stage blocker comments surface the recoverable uncommitted /
  staged state left in the worktree.
- `single-turn-harness-discipline`: implement and fix prompts declare the invocation single-turn and
  forbid deferring required commit/push work to a background task.

### Modified Capabilities
- (none — no existing requirement's behavior changes; `harness-uncommitted-salvage` and
  `blocked-recovery-recipes` are reused as-is.)

## Impact

- `core/scripts/stages/fix.ts` — retry loop around the harness invocation; salvage before the
  terminal block; blocker reason enrichment.
- `core/scripts/salvage-harness-work.ts` — reused unchanged; a read-only worktree-status helper may
  be shared from here or `worktree.ts`.
- `core/scripts/run-store.ts` — new retry event variant on `RunEvent`.
- `core/scripts/evidence-bundle.ts` — retry attempts recorded alongside existing recoveries.
- `core/scripts/prompts/fix.md`, `core/scripts/prompts/implementing.md` — single-turn discipline.
- `core/test/` — new/extended tests (`fix*.test.ts`, `prompt-loader.test.ts`, salvage tests).
- `plugin/` — regenerate via `node scripts/build.mjs`.
- No new config keys; the existing `auto_recovery_max_retries` governs the cap. No change to the
  implementing-stage `tryAutoRecover` path.
