## Why

The pre-merge delta review (#228, #359, #371) reads the PR head once, diffs
`reviewed-sha...head`, invokes the reviewer, and then records the verdict against that
`head`. Reviewer invocation is slow; a fix round can land a new commit while the delta
review is still in flight. When that happens the verdict is recorded against a commit that
is no longer the branch head, and its blocking keys gate the run even though the head
already resolves them.

The approve path already anticipates this: after a delta review with zero blocking
findings it re-reads the PR head and refuses to proceed on a stale approval. The
**blocking** path has no such re-validation — a superseded `needs-attention` verdict is
posted and acted on as if it described the head. That asymmetry is fail-open in the
direction that costs a human: the pipeline blocks on findings that no longer exist.

Observed twice on 2026-07-21:

- #427 run `427-2026-07-21T13-25-33-946Z`: delta verdict at `6c8a163` (fix-1) blocked on
  key `0e760c00` while head `dba0c95` (fix-2) had already fixed it. Cleared only by an
  audited `--override` with hand-verified code evidence.
- #432 run `432-2026-07-21T15-31-29-062Z`: delta verdict at `f02a973` (fix-1) blocked on
  5 high findings while head `625e304` (fix-2) had already resolved the majority. Cleared
  only by pushing a further commit to force a fresh head review.

Each occurrence costs a human intervention and writes misleading review history (a
blocking verdict attributed to code that was never at the head). As fix rounds get faster,
the race window closes less often on its own.

## What Changes

- **Head re-validation before recording a delta verdict.** Before a pre-merge delta-review
  verdict is recorded (comment posted with `reviewed-sha` / `verdict-diff-hash`
  sentinels and blocking-key marker), the stage confirms the reviewed SHA is still the PR
  branch head. This applies to *every* delta verdict — blocking and approving, initial and
  post-auto-fix re-review — not just the approve path that already checks.
- **Superseded verdicts are discarded, not blocking.** When a newer developer/fix commit
  exists at re-validation time, the verdict is recorded as *superseded* — it carries no
  blocking keys, does not `setBlocked`, and does not claim to describe the head — and the
  delta review re-runs against the current head. Re-running is bounded so a branch under
  continuous pushes degrades to the existing conservative re-review path rather than
  looping.
- **The unresolved-blocking-findings gate ignores stale verdicts.** A recorded verdict
  whose `reviewed-sha` precedes a newer developer commit on the PR is not a valid basis for
  blocking pre-merge: it triggers re-review at the head instead. Verdicts at the head, and
  verdicts separated from the head only by pipeline-internal commits, block exactly as
  today.
- **Regression tests replay both observed histories** through the stage seams with fakes.

## Impact

- Affected specs: `pre-merge-delta-recheck` (delta verdict recording), `review-sha-gating`
  (blocking-key gate staleness rule).
- Affected code: `core/scripts/stages/pre_merge.ts` (`enforceReviewShaGate` delta path and
  the `reuseBlockedBy` guard), plus `core/test/` regression coverage and the regenerated
  `plugin/` mirror.
- No change to the #16 pipeline-internal-commit classification, to `review_policy`
  partitioning, to review-round ceilings, or to the reviewer prompts.

## Acceptance criteria

- [ ] A delta review whose reviewed SHA is no longer the PR head when the verdict is ready
      does **not** produce a blocking verdict: no `setBlocked`, no `pipeline-blocking-keys`
      marker recorded for that SHA.
- [ ] Such a superseded verdict is visible on the PR as superseded (naming the reviewed SHA
      and the newer head), so review history is not misleading.
- [ ] After discarding a superseded verdict, the stage re-runs the delta review against the
      current head within the same pre-merge entry, at most a bounded number of times;
      exceeding the bound falls back to the existing conservative re-review path rather
      than looping or blocking on the stale verdict.
- [ ] The unresolved-blocking-keys gate does not block pre-merge on a verdict whose
      `reviewed-sha` precedes a newer developer commit on the PR; it routes to re-review.
- [ ] A verdict recorded at the current head with unresolved blocking keys still blocks
      pre-merge exactly as before (no regression of #228 / #229 gate-bypass protection).
- [ ] A verdict separated from the head only by pipeline-internal commits
      (`chore: archive OpenSpec change(s) for #…`) is still treated as current — the #16
      classification is unchanged.
- [ ] The post-auto-fix delta re-review (#359/#371) records its verdict under the same
      re-validation rule, and its existing approve-path head confirmation (GitHub API read
      plus `git ls-remote` disambiguation) is preserved.
- [ ] Regression test replays #427's history — verdict at fix-1 SHA `6c8a163`, head at
      fix-2 `dba0c95` — and asserts re-review at the head with no block on key `0e760c00`.
- [ ] Regression test replays #432's history — verdict at fix-1 SHA `f02a973`, head at
      fix-2 `625e304`, 5 blocking findings — and asserts re-review at the head with no
      block on the stale keys.
- [ ] Both regression tests fail against the pre-change implementation (the test bites).
- [ ] `npm run ci` passes from the repo root, including the regenerated `plugin/` mirror.

## Out of scope

- Any change to the #16 review-SHA gate's internal-commit classification —
  `docs:` / `chore: archive OpenSpec …` commits must still not invalidate verdicts.
- Cancelling an in-flight reviewer invocation when a push lands (the reviewer runs to
  completion; only the *recording* of its verdict is gated).
- Preventing concurrent fix pushes, or any locking/serialization between the fix round and
  pre-merge.
- Applying this rule to full review-1 / review-2 rounds outside the pre-merge delta path.
