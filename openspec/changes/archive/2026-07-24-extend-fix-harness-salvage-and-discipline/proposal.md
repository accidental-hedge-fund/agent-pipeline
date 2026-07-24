## Why

The `harness-uncommitted-salvage` fallback — stage completed-but-uncommitted harness
work into a commit so the normal verification validates it instead of discarding it —
only covers the implement (success path), fix-round, and test-fix surfaces. Two fix-harness
surfaces still **discard** completed work:

1. **Pre-merge bounded auto-fix** (`performPreMergeAutoFix`, #359): when the harness exits
   without a new commit but with a dirty worktree, the path runs `git reset --hard` +
   `git clean -fd` and returns `error`, discarding the fix. Observed on lyric-utils run
   `648/2026-07-23` during an override-triggered pre-merge resume: the fix harness
   implemented a correct blocking-finding fix, then ended its turn ≥10 times waiting on a
   background test run's notification that never arrives in the embedded `claude -p` context,
   exited without committing, and the full fix round's tokens/wall-clock were silently thrown
   away.
2. **Implement stage on harness failure/timeout** (`advance` implementing path): salvage runs
   only *after* the `!result.success` early-return, so a timed-out or crashed implement
   harness blocks with "no commits" **without** attempting salvage — even though the fix
   stage already salvages on the same crash/timeout path (#486). Observed twice more on
   lyric-utils (runs `649` and `727`): the implement harness completed the full feature but
   backgrounded its final test run, hit the stage timeout, and left salvageable work the
   timeout path did not recover.

The root cause of the deadlock is the same in every occurrence: the embedded harness has **no
re-invocation mechanism**, so "I'll wait for the background test run's notification before
committing" is always a dead end. The single-turn discipline that forbids this (spec
`single-turn-harness-discipline`) is present in `implementing.md` and `fix.md` but **absent**
from the gate-fix prompts (`test_fix.md`, `eval_fix.md`, `visual_fix.md`), each of which runs a
repository gate command the harness can background into the same deadlock.

Discarding completed work is strictly worse than salvaging it into the normal
commit-check / test-gate / re-review flow, and the block message today gives no hint that a
completed-but-uncommitted fix was thrown away. Frequency: 3 occurrences in ~2 days of runs.

Scope note (per issue #547 comment thread): the clean-worktree / cwd-mismatch investigation
(whether the pre-merge fix harness's edits reach the stage worktree at all) is split to #553
and is **out of scope here**. This change assumes the work reaches the worktree and makes the
pipeline preserve it once it does.

## What Changes

- **Extend salvage to the pre-merge bounded auto-fix path.** When the pre-merge auto-fix
  harness exits (success, crash, or timeout) with no new commit but a dirty worktree, the
  pipeline SHALL salvage the uncommitted work into a commit — instead of `git reset --hard`
  discarding it — and route that commit through the existing amend-to-auto-fix-subject +
  push + **delta re-review** flow, so the salvaged fix is validated by the reviewer, never
  merged unreviewed, and the one-attempt bound still holds. A genuinely clean worktree keeps
  the existing fail-closed rollback.
- **Extend salvage to the implement stage's harness failure/timeout path.** The implement
  stage SHALL attempt salvage before its no-commit/harness-failure block on the
  `!result.success` (crash/timeout) path, mirroring the fix stage's crash-retry salvage
  (#486); a failed salvage attempt SHALL disclose its reason in the block comment.
- **Extend the single-turn discipline to every gate-fix prompt.** `test_fix.md`,
  `eval_fix.md`, and `visual_fix.md` SHALL each state the invocation is single-turn and forbid
  ending the turn while committing depends on a background task (run gate commands in the
  foreground; never await a notification that will never arrive), drift-guarded by
  `prompt-loader.test.ts`.
- No review coverage is removed or demoted; salvaged commits flow through the same downstream
  verification as harness-authored commits (rigor-preserving per golden rule 3).

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `harness-uncommitted-salvage`: add requirements extending the salvage fallback to the
  pre-merge bounded auto-fix path and the implement-stage harness failure/timeout path.
- `single-turn-harness-discipline`: add a requirement extending the single-turn discipline text
  to the gate-fix prompts (`test_fix.md`, `eval_fix.md`, `visual_fix.md`).

## Impact

- Code: `core/scripts/stages/pre_merge.ts` (`performPreMergeAutoFix`),
  `core/scripts/stages/planning.ts` (implementing failure/timeout path),
  `core/scripts/prompts/{test_fix,eval_fix,visual_fix}.md`. No new modules or dependencies.
- Tests: `core/test/pre-merge*.test.ts`, `core/test/planning*.test.ts` (or the salvage test),
  `core/test/prompt-loader.test.ts`.
- Mirror: regenerate `plugin/` via `node scripts/build.mjs`.
- Behavior: no change to the "pipeline never merges" invariant — the pre-merge salvage path
  still stops at re-review; salvaged pre-merge fixes are re-reviewed exactly like a
  harness-authored auto-fix commit.

## Acceptance Criteria

- [ ] When the pre-merge bounded auto-fix harness exits with `headAfter === headBefore` and a
      **dirty** worktree, the pipeline creates a salvage commit (carrying the pre-merge
      auto-fix subject prefix and `Issue:`/`Pipeline-Run:` trailers) and pushes it, instead of
      running `git reset --hard` / `git clean -fd` and returning `error`.
- [ ] The salvaged pre-merge fix is subjected to the pre-merge delta re-review (SHA gate) —
      it is never treated as already-approved and never advances to `ready-to-deploy` without
      re-review.
- [ ] When the pre-merge auto-fix worktree is **genuinely clean** (nothing to salvage), the
      existing fail-closed rollback + `error` return is unchanged (no salvage commit created).
- [ ] The pre-merge auto-fix one-attempt bound (`PRE_MERGE_AUTOFIX_PREFIX`) still holds: a
      salvaged auto-fix commit is detected by the bound so a second auto-fix attempt is not
      launched.
- [ ] On the implement stage's `!result.success` (crash/timeout) path, the pipeline attempts
      salvage before blocking; a successful salvage advances to the normal downstream
      verification, and a failed salvage attempt surfaces its failure reason in the block
      comment.
- [ ] `test_fix.md`, `eval_fix.md`, and `visual_fix.md` each contain single-turn discipline
      text forbidding ending the turn while a commit depends on a background task, and a
      `prompt-loader.test.ts` assertion fails if the text is removed from any of them.
- [ ] New regression tests bite: each fails against the pre-change code (pre-merge salvage,
      implement-failure salvage, and each gate-fix prompt's discipline text) and passes after.
- [ ] `node scripts/build.mjs --check` reports the mirror in sync and `npm run ci` is green.
