## Why

`getPrDiff` shells to `gh pr diff`, and GitHub refuses that call with HTTP 406 when a PR touches more than 300 files (`PullRequest.diff too_large`). Review, pre-merge, design-gate, auto-merge eligibility, OpenSpec archive, and shipcheck all consume that helper. A valid large PR then cannot be reviewed, and the train STOPs on an infra failure instead of code quality. Live site: #1048 → PR #1222; `gh pr diff 1222` 406s and review-1 blocks.

## What Changes

- **Class law, not a PR #1222 mole.** `getPrDiff` SHALL try `gh pr diff` first. On HTTP 406 / diff-too-large it SHALL fall back to a paginated List pull request files call and return a composed unified-diff string. It SHALL NOT throw solely because GitHub refused the whole-PR diff.
- Callers keep receiving `Promise<string>` patch text. `diffFilePaths` and `truncateDiff` keep working. No caller-signature change.
- HTTP 406 / too_large stays deterministic (not a `ghRun` retry). The fallback runs after the first too-large failure.
- The fallback SHALL work without a local worktree. Path-based guards that read only PR data stay worktree-independent.
- Unit tests inject a fake runner: 406 → composed files-API diff; a small successful `gh pr diff` does not call the files API. No real network, git, or subprocess.

**BREAKING:** none. Callers already treat `getPrDiff` as a string-returning helper.

Non-goals: changing GitHub’s 300-file policy; bumping `gh` behavior; auto-merging large PRs without review; splitting the `plugin/` delete PR; chunking review prompts (owned by `review-prompt-too-large`).

## Acceptance criteria

- [ ] When `gh pr diff <pr>` succeeds, `getPrDiff` returns that stdout and does not call the pull-request files API.
- [ ] When `gh pr diff <pr>` fails with HTTP 406 or GitHub too-large wording (`too_large`, `exceeded maximum number of files`, `diff is too large`), `getPrDiff` returns a composed unified-diff string and does not throw for that reason.
- [ ] The composed string includes `diff --git a/<path> b/<path>` headers for each listed file so `diffFilePaths` still extracts paths. Existing callers keep receiving `Promise<string>`.
- [ ] The 406 fallback succeeds without a local worktree.
- [ ] A non-too-large `gh pr diff` failure still throws. An empty string is not a substitute for a failed retrieval.
- [ ] A unit test fakes HTTP 406 on `gh pr diff`, exercises the files-API fallback, and asserts a composed diff. A second test asserts a successful small `gh pr diff` does not call the files API. Tests inject I/O; they do not use real network, git, or subprocess.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `gh-pr-diff`: Typed `getPrDiff` retrieval of PR patch text. Fast path is `gh pr diff`. On HTTP 406 / too_large, paginated List pull request files composes a compatible unified-diff string without a worktree.

### Modified Capabilities

<!-- None. Living `openspec-integration` still reads the PR file list via the `getPrDiff`/`diffFilePaths` seam. That requirement does not change. Review, pre-merge, design-gate, and shipcheck keep calling `getPrDiff`. -->

## Impact

- **Primary:** `core/scripts/gh.ts` `getPrDiff` (today `gh pr diff` only). Add an injectable `GhRunOptions` seam like `getPrChecks`. Add a pure too-large classifier (same style as `isHttp404Signal`).
- **Callers (no signature change):** review-routing, pre-merge SHA gate, design_gate, auto_merge_eligibility, pre-merge-openspec-archive, shipcheck. They already block on `getPrDiff` throw as `harness-failure`.
- **Tests:** `core/test/gh.test.ts` (or a co-located `getPrDiff` test). Fake runner only.
- **Depends on:** living `gh-transient-retry` (406 is not retried); living `gh-call-metrics` (`getPrDiff` already tags `wrapperName`).
- **Does not:** merge inside advance/loop; skip review; change `truncateDiff` prompt caps; reverse papercut backlog policy.
- **Evidence:** `gh pr diff 1222 -R accidental-hedge-fund/agent-pipeline` → HTTP 406, max 300 files. v1.40.0 train STOP: `workflow-state` / `repeated_no_progress`.
- **Class vs site:** the site is PR #1222. The class is GitHub 406 on whole-PR diff. The next PR over 300 files uses the same wrapper and does not need a new mole issue.
}
