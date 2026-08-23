## 1. Regression tests that bite the 406 hole

- [ ] 1.1 Export a pure `isPrDiffTooLargeError(stderr)` helper from `core/scripts/gh.ts` and add co-located tests in `core/test/gh.test.ts` that assert true for HTTP 406 plus GitHub too-large wording (`too_large`, `exceeded maximum number of files`, `diff is too large`, `PullRequest.diff too_large`) and false for a SHA/path fragment that only contains `406` and for HTTP 404. Verify those classifier tests pass
- [ ] 1.2 Add an injectable-runner test that calls `getPrDiff` with a fake `GhRunOptions.runner`: `pr diff` throws `HTTP 406: diff exceeded maximum number of files (300)`; the files API returns a `--slurp` JSON page with two files (one with `patch`, one without). Assert the result contains `diff --git` headers for both paths and the supplied patch, that `pr diff` ran once (no transient retry), and that no real network/git/subprocess ran. Verify this test **fails** against current `getPrDiff` (throws on 406)
- [ ] 1.3 Add a second injectable-runner test whose `pr diff` returns a small unified diff. Assert `getPrDiff` returns that stdout and does **not** call the files API. Verify this test **passes** against current `getPrDiff` (fast path already works)
- [ ] 1.4 Add a third injectable-runner test whose `pr diff` throws HTTP 404. Assert `getPrDiff` throws and does not call the files API. Verify this test **passes** against current `getPrDiff`

## 2. getPrDiff files-API fallback

- [ ] 2.1 Accept optional `opts?: GhRunOptions` on `getPrDiff` (same pattern as `getPrChecks`) and pass `{ ...opts, timeoutMs: 60_000, wrapperName: "getPrDiff" }` to `ghRun` so tests can inject `runner`. Verify tasks 1.3 and 1.4 still pass
- [ ] 2.2 On `gh pr diff` failure, if `isPrDiffTooLargeError` is true, paginate `gh api repos/<repo>/pulls/<n>/files --paginate --slurp`, flatten page arrays the same way as `getOpenIssues`, and compose a unified-diff string (`diff --git a/<from> b/<to>`, `previous_filename` on rename, include `patch` when present, header-only when `patch` is absent). Do not require a worktree. Do not retry the 406 `pr diff` as transient. If the files list itself fails, throw (do not return empty). Verify task 1.2 now passes
- [ ] 2.3 Keep the successful `gh pr diff` path returning stdout unchanged. Do not apply prompt `truncateDiff` inside `getPrDiff`. Do not change caller signatures. Verify existing `core/test/gh.test.ts` retry/metrics tests still pass

## 3. Gate

- [ ] 3.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 3.2 Run `openspec validate getprdiff-files-api-fallback` and `npm run ci` from the repo root. Verify both are green. Do not skip review of large PRs. Do not add an `auto_merge` key or merge stage
}
