## 1. Understand and audit the current implementation

- [x] 1.1 Read `core/scripts/gh.ts` `getPrForIssue` (lines ~617–661) and confirm the exact body-text patterns being removed
- [x] 1.2 Confirm all 5 call sites (pipeline.ts status path, planning.ts ×2, review.ts, pre_merge.ts, deploy_ready.ts) and verify none rely on body-text match behavior

## 2. Implement the fix in `getPrForIssue`

- [x] 2.1 Remove the `refs` array and the body/title text-search loop from `getPrForIssue`
- [x] 2.2 After the branch-prefix check, iterate the PR list and call `gh pr view <N> --json closingIssuesReferences -R <repo>` for each candidate PR
- [x] 2.3 Return the PR number if `closingIssuesReferences` contains the target issue number; return `null` if no PR matches either strategy

## 3. Add regression test

- [x] 3.1 Add a unit test in `core/test/` that mocks an unrelated PR with `#42` in its body (and no closing reference, no pipeline branch) and asserts `getPrForIssue(cfg, 42)` returns `null`
- [x] 3.2 Add a unit test for the closing-references happy path: a PR whose `closingIssuesReferences` includes issue #42, no pipeline branch, asserts the correct PR number is returned
- [x] 3.3 Ensure existing branch-prefix test (if any) still passes; add one if absent

## 4. Sync plugin mirror

- [x] 4.1 Run `node scripts/build.mjs` (or equivalent) to regenerate `plugin/` from `core/`
- [x] 4.2 Verify the plugin mirror reflects the updated `getPrForIssue` implementation

## 5. Verify and close

- [x] 5.1 Run `pnpm test` — all tests must pass
- [x] 5.2 Manually verify with `--dry-run` on a real issue that `--status` reports the correct PR (or none)
