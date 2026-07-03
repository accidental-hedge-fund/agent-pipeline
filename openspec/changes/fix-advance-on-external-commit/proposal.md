## Why

When a human manually commits a fix and pushes it — for example to resolve an
OpenSpec stale-delta blocker that the fix harness cannot converge — the pipeline
re-enters the fix stage on the next run, invokes the fix harness, and the harness
correctly produces no new commits because the work is already done. The current
no-commit path (`fix.ts`) sees `headBefore === headAfter`, finds nothing to
salvage in a clean worktree, and blocks with
`"fix-N reported success but produced no new commits."` Recovering requires yet
another manual label-advance, even though the fix the reviewer asked for is
already present on the branch.

The block path never compares HEAD against the SHA the reviewer last saw
(`review_sha`). When commits exist that the reviewer has not yet reviewed, the
correct action is to advance so the next review round evaluates them — not to
block as if nothing happened.

## What Changes

- `core/scripts/stages/fix.ts`: in the no-new-commits branch (after
  `trySalvageUncommittedWork` returns false, at the `headBefore === headAfter`
  block path), before blocking, look up the latest trusted review SHA via the
  existing `extractReviewedSha` helper. If a review SHA is extractable and
  `HEAD !== review_sha` (commits exist the reviewer has not seen), treat the fix
  as "already applied externally" and advance to the next stage (`review-2` for
  round 1, `pre-merge` for round 2) instead of blocking. If `HEAD === review_sha`
  (genuinely nothing was done) or no review SHA is extractable, block as today
  (fail closed).
- Co-located regression tests in `core/test/` covering all three paths.

This reuses the same review-SHA extraction already used by the pre-merge
consistency guard (`openspec-consistency.ts:134`); it does not introduce a new
SHA-tracking mechanism.

## Acceptance Criteria

- [ ] When the fix harness produces 0 new commits (`headBefore === headAfter`) and salvage finds nothing, but `HEAD` differs from the latest trusted review SHA, the fix stage advances to the next stage (round 1 → `review-2`, round 2 → `pre-merge`) rather than blocking.
- [ ] When the fix harness produces 0 new commits and salvage finds nothing and `HEAD` equals the latest trusted review SHA, the fix stage blocks exactly as before (`no-commits` blocker).
- [ ] When no trusted review SHA is extractable from the issue comments, the fix stage blocks as before (fail closed — no advance on a missing SHA).
- [ ] The advance-on-external-commit path posts a transition explaining the fix was already applied externally and moves the label to the correct next stage.
- [ ] Regression tests cover all three paths (advance, block-on-equal-SHA, block-on-missing-SHA) and bite (fail without the fix).

## Scope

- Only the fix stage's no-new-commits decision changes. No state-machine edges are added or removed; the round-1 → `review-2` and round-2 → `pre-merge` targets are the existing fix-stage transitions.
- Problem 1 from issue #349 (OpenSpec divergence detected too late) was fixed by #356 and is out of scope here.
- The salvage path (`trySalvageUncommittedWork`) is unchanged; the new decision only runs after salvage has already returned false.

## Impact

- `core/scripts/stages/fix.ts` and co-located tests in `core/test/`.
- No changes to any other pipeline stage, the review-SHA extraction helper, or the state machine.
