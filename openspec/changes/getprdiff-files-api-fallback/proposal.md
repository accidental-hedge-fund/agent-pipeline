## Why

`getPrDiff` shells to `gh pr diff`, and GitHub refuses that call with HTTP 406 when a PR touches more than 300 files (`PullRequest.diff too_large`). Review, pre-merge, design-gate, auto-merge eligibility, OpenSpec archive, and shipcheck all consume that helper. A valid large PR then cannot be reviewed, and the train STOPs on an infra failure instead of code quality. Live site: #1048 → PR #1222; `gh pr diff 1222` 406s and review-1 blocks.

## What Changes

- **Class law, not a PR #1222 mole.** `getPrDiff` SHALL try `gh pr diff` first. On HTTP 406 / diff-too-large it SHALL fall back to a paginated List pull request files call and return a composed unified-diff string. It SHALL NOT throw solely because GitHub refused the whole-PR diff.
- When a files-list entry omits `patch` but reports a non-zero text change, the fallback SHALL materialize that file from the Git blobs / contents API (worktree-independent). It SHALL NOT present a header-only string as a complete review of omitted text hunks.
- When pagination hits GitHub's 3,000-file files-list ceiling, `getPrDiff` SHALL throw an actionable incompleteness error. It SHALL NOT return a prefix list as a complete diff.
- Callers keep receiving `Promise<string>` patch text. `diffFilePaths` and `truncateDiff` keep working. No caller-signature change.
- HTTP 406 / too_large stays deterministic (not a `ghRun` retry). The fallback runs after the first too-large failure.
- The fallback SHALL work without a local worktree. Path-based guards that read only PR data stay worktree-independent.
- Unit tests inject a fake runner covering fast path, 406 fallback, incompleteness, and classifier false positives. No real network, git, or subprocess.

**BREAKING:** none. Callers already treat `getPrDiff` as a string-returning helper.

Non-goals: changing GitHub’s 300-file or 3,000-file policy; bumping `gh` behavior; auto-merging large PRs without review; splitting the `plugin/` delete PR; chunking review prompts (owned by `review-prompt-too-large`); adding a JS diff library; requiring local `git diff`.

## Acceptance criteria

- [ ] When `gh pr diff <pr>` succeeds, `getPrDiff` returns that stdout and does not call the pull-request files API.
- [ ] When `gh pr diff <pr>` fails with HTTP 406 status syntax or GitHub too-large wording (`too_large`, `exceeded the maximum number of files`, `exceeded maximum number of files`, `diff is too large`, `PullRequest.diff too_large`), `getPrDiff` does not throw for that reason and proceeds to the files-list fallback.
- [ ] The composed string includes `diff --git a/<path> b/<path>` headers for each listed file so `diffFilePaths` still extracts paths, including renamed (`previous_filename` on `a/`), deleted, and space-containing paths. Existing callers keep receiving `Promise<string>`.
- [ ] When a files-list entry has a `patch` field, that patch text appears under its header.
- [ ] When a files-list entry omits `patch` and `changes > 0`, the composed string includes materialized hunk text from the Git blobs / contents API, or `getPrDiff` throws naming those paths. It does not succeed with header-only output for those files.
- [ ] When a files-list entry omits `patch` and `changes === 0` (binary / empty / mode-only), the composed string still includes the path header and `getPrDiff` succeeds.
- [ ] When the flattened files list has 3000 or more entries, `getPrDiff` throws an incompleteness error naming GitHub's 3000-file cap and does not return a composed prefix.
- [ ] The 406 fallback succeeds without a local worktree and does not invoke `git diff`.
- [ ] A non-too-large `gh pr diff` failure still throws. A SHA/path fragment containing the digits `406` is not a too-large signal. An empty string is not a substitute for a failed retrieval. Files-list failure after 406 still throws.
- [ ] Unit tests inject I/O; they do not use real network, git, or subprocess. Coverage includes: small fast path; HTTP 406 composed fallback; multi-page flatten; rename; patch-less binary; omitted-text materialization; 3000-cap throw; 404 propagation; digit-fragment 406; files-API failure; no git/worktree invocation.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `gh-pr-diff`: Typed `getPrDiff` retrieval of PR patch text. Fast path is `gh pr diff`. On HTTP 406 / too_large, paginated List pull request files composes a compatible unified-diff string without a worktree. Omitted text patches are materialized via Git blobs / contents. A 3000-file list is incompleteness, not a successful partial review.

### Modified Capabilities

<!-- None. Living `openspec-integration` still reads the PR file list via the `getPrDiff`/`diffFilePaths` seam. That requirement does not change. Review, pre-merge, design-gate, and shipcheck keep calling `getPrDiff`. -->

## Impact

- **Primary:** `core/scripts/gh.ts` `getPrDiff` (today `gh pr diff` only). Add an injectable `GhRunOptions` seam like `getPrChecks`. Add a pure too-large classifier (same style as `isHttp404Signal`).
- **Callers (no signature change):** review-routing, pre-merge SHA gate, design_gate, auto_merge_eligibility, pre-merge-openspec-archive, shipcheck. They already block on `getPrDiff` throw as `harness-failure`.
- **Tests:** `core/test/gh.test.ts` (or a co-located `getPrDiff` test). Fake runner only.
- **Depends on:** living `gh-transient-retry` (406 is not retried); living `gh-call-metrics` (`getPrDiff` already tags `wrapperName`).
- **Does not:** merge inside advance/loop; skip review; change `truncateDiff` prompt caps; reverse papercut backlog policy.
- **Evidence (live, 2026-08-23):** `gh pr diff 1222 -R accidental-hedge-fund/agent-pipeline` → `HTTP 406: Sorry, the diff exceeded the maximum number of files (300)` plus `PullRequest.diff too_large`. `gh api repos/…/pulls/1222/files?per_page=100 --paginate --slurp` → 4 pages `[100,100,100,77]`, 377 files, 8 removed text files with `changes > 0` and no `patch`. v1.40.0 train STOP: `workflow-state` / `repeated_no_progress`.
- **Class vs site:** the site is PR #1222. The class is GitHub 406 on whole-PR diff plus honest completeness of the files-list fallback. The next PR over 300 files uses the same wrapper and does not need a new mole issue.
