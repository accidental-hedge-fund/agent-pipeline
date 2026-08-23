## Context

See `proposal.md` for why. Current law and code:

- `core/scripts/gh.ts` `getPrDiff` (line 670) is `gh pr diff <n> -R <repo>` via `ghRun`, timeout 60s, `wrapperName: "getPrDiff"`. It does not accept `GhRunOptions`. A non-zero exit throws. Callers catch that as `harness-failure`.
- GitHub refuses the whole-PR diff media type at 300 files (and at a size ceiling) with HTTP 406 / `PullRequest.diff too_large`. Repro: `gh pr diff 1222 -R accidental-hedge-fund/agent-pipeline`.
- `isTransientGhError` does **not** treat 406 as transient, so `ghRun` throws after one attempt. That is correct. The bug is the missing fallback after that throw.
- Callers that need the string: review-routing, pre-merge SHA gate, design_gate, auto_merge_eligibility, pre-merge-openspec-archive, shipcheck. `diffFilePaths` parses `diff --git a/<path> b/<path>`. Prompt assembly truncates the **whole** string later (`truncateDiff` 50_000 chars). OpenSpec head-side guards read this seam, not the worktree filesystem.
- `getPrChecks` already accepts optional `GhRunOptions` for injectable `runner`. `getOpenIssues` already paginates `gh api … --paginate --slurp` and flattens page arrays.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is PR #1222 (`plugin/` delete, 300+ files) 406-ing `gh pr diff` and blocking review-1. The class is: GitHub’s whole-PR diff endpoint is capped; any valid PR over that cap must still yield inspectable patch text from the shared helper. A review-routing-only catch of 406, or a one-off skip of #1222, is a mole.
2. **Shared surfaces.** The classifier and fallback live in `getPrDiff` (`core/scripts/gh.ts`). No new `BlockerKind`, recovery recipe, or second recoverer. After the wrapper succeeds, existing review/pre-merge/shipcheck paths proceed. `isTransientGhError` stays unchanged (406 is deterministic). Metrics keep tagging `getPrDiff`.
3. **Next identical fault.** The next PR whose `gh pr diff` 406s uses the same wrapper. The unit test that fakes 406 and expects a composed files-list diff fails if the fallback is removed. No new mole issue for the same 406.

## Goals / Non-Goals

**Goals:**

- Fast path remains `gh pr diff`.
- HTTP 406 / too-large falls back to paginated List pull request files and returns composed unified-diff text.
- Returned shape stays `Promise<string>` with `diff --git` headers.
- Fallback works without a worktree.
- Tests inject a fake runner and would have caught PR #1222’s 406.

**Non-Goals:**

- Changing GitHub’s 300-file or 3000-file list caps.
- Caller signature changes or per-stage moles.
- Local `git diff` as a required fallback (worktree-independent guards).
- Raising or chunking the review prompt ceiling (`review-prompt-too-large`).
- Auto-merging large PRs; skipping review; splitting the `plugin/` delete PR.
- Classifying 406 as transient or adding a new blocker kind.

## Decisions

### 1. Fallback lives in getPrDiff, not in each caller

**Choice:** Extend `getPrDiff` only. Keep every caller on `deps.getPrDiff ?? defaultGetPrDiff`. Add optional `opts?: GhRunOptions` so tests inject `runner`, matching `getPrChecks`.

**Why:** One GitHub limit, one helper, many consumers. A review-only try/catch would leave pre-merge SHA hashing, design_gate, OpenSpec archive, eligibility, and shipcheck still 406-blind. Class-over-site requires the shared wrapper.

**Alternatives considered:**

- Catch 406 in review-routing only → rejected. Site mole. Other callers still STOP the train.
- Replace `gh pr diff` with files API always → rejected. Extra pagination and composition on every small PR. Fast path is cheaper and already correct under 300 files.
- Local `git diff` in the managed worktree as the fallback → rejected as the required path. OpenSpec head-side guards and some review paths must work when the worktree is absent. Local git MAY be a later optional enrichment; this cut MUST compose from GitHub PR data.

### 2. Classify too-large with a pure exported helper

**Choice:** Export `isPrDiffTooLargeError(stderr: string): boolean`. True only on explicit HTTP/status 406 syntax **or** GitHub too-large wording (`too_large`, `exceeded maximum number of files`, `diff is too large`, `PullRequest.diff too_large`). False for a bare `406` token or a SHA/path fragment. Same discipline as `isHttp404Signal` (#714). `getPrDiff` catches the `gh pr diff` throw, tests the classifier, and either falls back or rethrows.

**Why:** GitHub’s 406 text has varied (`diff exceeded maximum number of files (300)` vs `PullRequest.diff too_large`). Status 406 plus wording covers both. A SHA containing `406` must not trigger fallback. Do not add 406 to `isTransientGhError` — that would retry the same refused call three times before falling back.

**Alternatives considered:**

- Treat every 406 as too-large with no wording check → acceptable if scoped to `gh pr diff` stderr, but wording still helps when `gh` wraps the status.
- Retry 406 via `isTransientGhError` → rejected. Deterministic GitHub policy. Wastes ~seconds and three identical 406s.
- Classify on file count from `gh pr view --json files` first → rejected. Extra call on every PR, and `files` on that endpoint is also truncated.

### 3. Compose unified-diff text from the files-list JSON

**Choice:** After too-large, call `gh api repos/<repo>/pulls/<n>/files --paginate --slurp` (same pagination pattern as `getOpenIssues`). Flatten page arrays. For each file:

- Emit `diff --git a/<from> b/<to>` (`from` is `previous_filename` when present, else `filename`; `to` is `filename`).
- If `patch` is present, append it.
- If `patch` is absent, still emit the header (binary / GitHub-omitted hunk).

Do not apply prompt `truncateDiff` inside `getPrDiff`. Callers already truncate at prompt-build time.

**Why:** `diffFilePaths` and OpenSpec change-id extraction only need those headers. Reviewers still get per-file hunks when GitHub sends `patch`. Keeping composition in the helper means no caller changes.

**Alternatives considered:**

- Return a structured file list and change every caller → rejected. Issue requires compatible string patch text.
- Fetch each file’s contents via Contents API to rebuild hunks → rejected as the default. N extra round trips. The files list already carries `patch` for text files.
- Per-file truncation inside `getPrDiff` → rejected. Today’s cap is whole-diff at prompt assembly. Inventing a second cap here would drift from `truncateDiff`.

### 4. Injectable runner tests in gh.test.ts

**Choice:** Co-located tests in `core/test/gh.test.ts` (or a sibling `gh-pr-diff.test.ts` if the file grows past local convention). Inject `opts.runner`:

1. First args are `pr diff …` → throw stderr `HTTP 406: diff exceeded maximum number of files (300)`. Next args are `api repos/…/pulls/…/files` → return a `--slurp` JSON page with two files (one with `patch`, one without). Assert the composed string has both `diff --git` headers and the supplied patch. Assert `pr diff` was called once (no transient retry).
2. `pr diff` returns a small patch. Assert the files API is never called.

Prove test 1 fails against current `getPrDiff` (throws on 406). No real `gh`, git, or network.

**Why:** AC tests. The existing `ghRunForTest` / `GhSubprocessRunner` seam is the repo pattern. Production callers omit `opts`.

**Alternatives considered:**

- Stage-level tests that fake `deps.getPrDiff` → they already do. Those tests would not have caught this bug (they never call the real helper). The regression MUST sit on `getPrDiff` itself.

### 5. GitHub’s 3000-file files-list cap is residual, not a throw

**Choice:** Paginate the files endpoint to completion. If GitHub truncates at 3000 files, still return the composed string (with a trailing marker that the list was truncated). Do not throw 406. Do not invent a second GitHub policy.

**Why:** The class bug is the 300-file **diff** cap. The files list’s 3000-file cap is a different GitHub limit. Throwing would re-STOP the train on a slightly larger PR. A visible marker is fail-visible without making review impossible. Out of scope to page past GitHub’s hard cap.

**Alternatives considered:**

- Throw when 3000 files are returned → rejected. Same infra STOP the issue exists to remove, at a higher threshold.
- Local git diff when the list is truncated → optional later; not required this cut (worktree independence).

## Risks / Trade-offs

- **[Risk] Composed diff is huge and trips `review-prompt-too-large`.** → Mitigation: that is the correct next gate, already specified. This change makes the PR inspectable; it does not skip the prompt ceiling. Do not chunk diffs here.
- **[Risk] Files-list `patch` omits binaries and some large files.** → Mitigation: still emit `diff --git` headers so path-based guards see every listed file. Reviewers lose hunks GitHub already omitted; that matches GitHub’s own files view.
- **[Risk] `--paginate --slurp` JSON shape (array of pages vs one array).** → Mitigation: flatten the same way `getOpenIssues` does. Unit-test both a single page array and a slurp-of-pages fixture.
- **[Risk] Fallback adds one `gh api` call (plus pages) on large PRs.** → Acceptable. Metrics stay under wrapper name `getPrDiff`. Small PRs pay zero extra calls.
- **[Risk] 406 classifier false-positive on unrelated 406.** → Mitigation: classifier is only applied to the `gh pr diff` error, not to every `gh` call. SHA-fragment `406` is excluded.
- **[Trade-off] Fallback patch text will not byte-match `gh pr diff` stdout** (index lines, `/dev/null` for add/delete). Acceptable: callers need headers + hunks, not a byte-identical GitHub media type.

## Migration Plan

1. Land `getPrDiff` fallback, classifier, `GhRunOptions` seam, and tests on this branch. After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
2. Merge. The next large-PR review (including a re-run of #1048 / PR #1222) uses the wrapper without a new mole issue.
3. Do not auto-merge the large PR. Review of the composed diff remains mandatory.
}
