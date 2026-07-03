## 1. Advance-on-external-commit decision in the fix stage

- [ ] 1.1 In `advanceFix` (`fix.ts`), inside the `headBefore === headAfter` branch after `trySalvageUncommittedWork` returns false and before `setBlocked(..., "no-commits")`, resolve the latest trusted review SHA from `detail.comments` via `extractReviewedSha` (the same helper `openspec-consistency.ts` uses).
- [ ] 1.2 Read the current `HEAD` SHA of the worktree (`headAfter` already holds it — reuse it).
- [ ] 1.3 If a review SHA is present (`reviewShaResult?.sha` is a non-null 40-char SHA) AND it differs from `HEAD`, transition to the next stage (`review-2` for round 1, `pre-merge` for round 2) with a message noting the fix was already applied externally, and return an advanced Outcome.
- [ ] 1.4 Otherwise (SHA equals HEAD, or no extractable SHA) fall through to the existing `setBlocked(..., "no-commits")` block path unchanged.
- [ ] 1.5 Keep the decision injectable/testable: reuse the existing `detail` comments already fetched in `advanceFix`; do not add a new network call in the no-commit path.

## 2. Regression tests

- [ ] 2.1 Advance path: harness produces no new commits, salvage returns false, a trusted review comment carries a SHA ≠ HEAD → `advanceFix` returns `advanced: true` to the correct next stage and does NOT call `setBlocked`.
- [ ] 2.2 Block-on-equal-SHA path: same setup but the trusted review SHA equals HEAD → blocks with `no-commits` (existing behavior).
- [ ] 2.3 Block-on-missing-SHA path: no extractable review SHA (no review comment / comment without a SHA) → blocks with `no-commits` (fail closed).
- [ ] 2.4 Prove the tests bite: they fail against the pre-change `fix.ts`.

## 3. Mirror + CI

- [ ] 3.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror.
- [ ] 3.2 `npm run ci` green from the repo root (`ci:core`, mirror check, install smoke, `openspec validate --all`).
