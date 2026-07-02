## 1. Eligibility classifier

- [ ] 1.1 Add a pure helper (e.g. `isAutoFixableFinding(f: ReviewFinding): boolean`) in
  `pre_merge.ts` (or `review-policy.ts`) returning `true` iff `f.category` normalizes to exactly
  `correctness` or `missing-dep`. Absent/empty/unknown category → `false`.
- [ ] 1.2 Add `allBlockingAutoFixable(blocking: ReviewFinding[]): boolean` — `true` iff the array is
  non-empty and every element passes `isAutoFixableFinding`. Empty array → `false` (no findings to
  fix; not the fix-round path).

## 2. Auto-fix marker + one-attempt bound

- [ ] 2.1 Define a stable auto-fix commit-subject prefix constant (e.g.
  `PRE_MERGE_AUTOFIX_PREFIX = "fix: pre-merge auto-fix"`), documented as developer-classified.
- [ ] 2.2 Confirm (and cover by test) that `isPipelineInternalCommit(<autofix subject>)` returns
  `false` — the prefix MUST NOT be added to the internal-commit set.
- [ ] 2.3 Add `priorAutoFixAttempted(commits: FixCommit[]): boolean` scanning the post-reviewed-SHA
  developer commits for the prefix; used to enforce the one-attempt bound crash-safely.

## 3. Bounded auto-fix closure (mirror `performBoundedSpecRepair`)

- [ ] 3.1 Implement `performPreMergeAutoFix(cfg, issueNumber, blockingFindings, pipelineRunId, wtPath,
  gitFn, invokeFn, ...)` returning a bounded result (`fixed` | `still-blocking` | `error` |
  `already-attempted`).
- [ ] 3.2 Pre-fix cleanliness check: fail closed (`error`) if the worktree has uncommitted changes
  before the attempt (rollback below uses `git reset --hard`).
- [ ] 3.3 Build the prompt via `buildFixPrompt` with the blocking delta findings as `reviewFindings`
  (surgical-fix discipline #235 preserved); invoke the implementer harness from `wtPath` with
  `cfg.fix_timeout`, `cfg.models?.fix`, `cfg.harness_sandbox`.
- [ ] 3.4 On harness failure / no commit produced / residual dirty tree: `git reset --hard <preHead>`
  + `git clean -fd`, return `error`.
- [ ] 3.5 Ensure the fix commit subject uses `PRE_MERGE_AUTOFIX_PREFIX` and carries `Issue: #N` /
  `Pipeline-Run: <id>` trailers; push it to the PR head.

## 4. Wire into the delta-review blocking branch

- [ ] 4.1 In `advance()` delta-review path (`pre_merge.ts` ~L1121–1150), before the existing
  `setBlocked(..., "needs-human")`: when `partition.blocking.length > 0`, evaluate
  `allBlockingAutoFixable(partition.blocking)` AND `!priorAutoFixAttempted(...)` AND the harness is
  configured.
- [ ] 4.2 Not eligible (non-allowlisted category, or prior attempt exists, or no harness) → keep the
  current `setBlocked(..., "needs-human")` behavior unchanged.
- [ ] 4.3 Eligible → run `performPreMergeAutoFix`. On `error`/`already-attempted` → `setBlocked
  (..., "needs-human")`.
- [ ] 4.4 On a successful fix commit → re-run the delta review once against the new head; post the
  delta comment with fresh `reviewed-sha`/`verdict-diff-hash` sentinels; do NOT increment the
  review-2 ceiling counter.
- [ ] 4.5 Re-review approves (or all sub-policy) → return `null` (pre-merge proceeds). Re-review still
  blocks → `setBlocked(..., "needs-human")` with no second attempt.
- [ ] 4.6 Add the injectable seams to `AdvancePreMergeDeps` (e.g. `attemptPreMergeAutoFix`,
  reuse `invokeFn`, `branchDeveloperCommits`) with production defaults, mirroring the #356 wiring.

## 5. Tests (DI seams only — no real harness/git/network)

- [ ] 5.1 Blocks on all-`correctness` findings → auto-fix attempted → re-review approves → advances
  (`return null`); assert the fix seam was called exactly once and the delta comment was re-posted.
- [ ] 5.2 Blocks on a `product-judgment-required` finding (or mixed with `correctness`) → no auto-fix
  → immediate `setBlocked(..., "needs-human")`; assert the fix seam was NOT called.
- [ ] 5.3 Blocks on a `security` finding → no auto-fix → immediate `needs-human`.
- [ ] 5.4 Absent/unknown category among blocking findings → no auto-fix → `needs-human` (fail-closed).
- [ ] 5.5 One-attempt bound: a prior auto-fix commit is present in the branch history and the
  re-review still blocks → `needs-human`, fix seam NOT called a second time.
- [ ] 5.6 Auto-fix failure (harness error / dirty tree) → rollback + `needs-human`, no partial push.
- [ ] 5.7 Developer classification: `isPipelineInternalCommit(PRE_MERGE_AUTOFIX_PREFIX + " …")`
  returns `false`.
- [ ] 5.8 Re-review does not increment `max_adversarial_rounds`.
- [ ] 5.9 Prove the tests bite: with the eligibility branch reverted (straight to `setBlocked`), 5.1
  and 5.5 fail; restore.

## 6. Mirror + CI

- [ ] 6.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror.
- [ ] 6.2 `npm run ci` green end-to-end (core tests + `build.mjs --check` + install smoke +
  `openspec validate --all`).
