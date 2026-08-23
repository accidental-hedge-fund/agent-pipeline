## 1. Classifier and biting regressions

- [x] 1.1 Export `isPrDiffTooLargeError(stderr)` from `core/scripts/gh.ts`. Add co-located tests in `core/test/gh.test.ts` that assert true for live PR #1222 stderr (`HTTP 406` + `exceeded the maximum number of files` + `PullRequest.diff too_large`), `status code: 406`, and too-large wording without a 406 status; false for `"406"`, `error: 406 Not Found`, SHA fragment `a406bcafe`, and HTTP 404. Verify those classifier tests pass
- [x] 1.2 Add an injectable-runner test: `pr diff` throws live-shaped HTTP 406 too-large; files API returns `--slurp` JSON with two files (one with `patch`, one `changes === 0` without). Assert both `diff --git` headers, the supplied patch, `pr diff` ran once, files args include `repos/<cfg.repo>/pulls/<n>/files`, `--paginate`, `--slurp`, and no `git` args. Verify this test **fails** against current `getPrDiff`
- [x] 1.3 Add a test whose `pr diff` returns a small unified diff. Assert that stdout is returned and the files API is not called. Verify this test **passes** against current `getPrDiff`
- [x] 1.4 Add a test whose `pr diff` throws HTTP 404. Assert throw, files API not called. Verify this test **passes** against current `getPrDiff`
- [x] 1.5 Add a test whose `pr diff` throws `HTTP 500 … ref=a406bcafe`. Assert throw, files API not called, classifier false

## 2. getPrDiff files-API fallback

- [x] 2.1 Accept optional `opts?: GhRunOptions` on `getPrDiff` (same pattern as `getPrChecks`). Fast path: `ghRun(["pr","diff",String(n),"-R",cfg.repo], { ...opts, timeoutMs: 60_000, retries: 1, wrapperName: "getPrDiff" })`. Verify tasks 1.3–1.5 still pass
- [x] 2.2 On too-large, call `gh api repos/${cfg.repo}/pulls/${n}/files?per_page=100 --paginate --slurp` (timeout 120s, same `wrapperName`). Flatten `DiffEntry[][]`. Compose `diff --git a/<from> b/<to>` (`previous_filename` on rename; raw paths). Include `patch` when present. Do not require a worktree. Do not retry the 406 `pr diff`. If the files list fails or JSON is empty/invalid, throw (do not return empty). Verify task 1.2 now passes
- [x] 2.3 Keep the successful `gh pr diff` path returning stdout unchanged. Do not apply prompt `truncateDiff` inside `getPrDiff`. Do not change caller signatures. Do not add 406 to `isTransientGhError`. Verify existing `core/test/gh.test.ts` retry/metrics tests still pass

## 3. Completeness: omitted text + 3000-file cap

- [x] 3.1 When `patch` is absent and `changes === 0`, emit the path header only (binary/empty/mode-only). Add a test for `bin/app.bin` with no patch. Verify `diffFilePaths` still sees the path
- [x] 3.2 When `patch` is absent and `changes > 0`, fetch `gh api repos/${cfg.repo}/git/blobs/${sha}`, decode base64, and compose add/delete hunks from the text (NUL → binary marker). For modified/renamed-with-edits, fetch `gh api repos/${cfg.repo}/pulls/${n}` once (capture `base.sha` and `head.sha`), then `compare/{base.sha}...{head.sha}` → `merge_base_commit.sha`, then contents at that merge-base ref for the old blob (not the moving base tip). Blob/contents failure throws naming the path. Add tests: removed omitted-text materializes a `-` line from the blob (**fails** against header-only); blob failure throws; no `git` args. Verify against a fixture matching PR #1222's omitted deletes
- [x] 3.5 Add a regression where the PR `base.sha` (base-branch tip) differs from compare `merge_base_commit.sha`. Assert the synthesized modified hunk uses the merge-base blob, not the tip blob, and that contents is called with `ref=<merge-base>`
- [x] 3.6 Pin files-list fallback collection: read base/head before listing files, verify the same pair after pagination, retry up to 3 times, fail closed if the PR is still moving. Compose merge-base from the pinned pair only. Add an injected H1→H2 race regression (must not compose H1 blobs with H2 merge-base) and a persistent-movement fail-closed test
- [x] 3.3 After flatten, if `files.length >= 3000`, throw naming the 3000-file cap; do not return a composed prefix. Add an injectable test with 3000 stub entries
- [x] 3.4 Add tests for multi-page slurp `[[a],[b]]`, rename `a/old.ts b/new.ts`, space path `foo bar.ts`, and files-API failure after 406 (throw, not `""`)

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 4.2 Run `openspec validate getprdiff-files-api-fallback` and `npm run ci` from the repo root. Verify both are green. Do not skip review of large PRs. Do not add an `auto_merge` key or merge stage. Do not claim a suite pass without this evidence
