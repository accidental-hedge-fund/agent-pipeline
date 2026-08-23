## Context

See `proposal.md` for why. Current law and code:

- `core/scripts/gh.ts` `getPrDiff` (line 670) is `gh pr diff <n> -R <repo>` via `ghRun`, timeout 60s, `wrapperName: "getPrDiff"`. It does not accept `GhRunOptions`. A non-zero exit throws. Callers catch that as `harness-failure`.
- GitHub refuses the whole-PR diff media type at 300 files (and at a size ceiling) with HTTP 406 / `PullRequest.diff too_large`. Live stderr (PR #1222, 2026-08-23):

  `could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/accidental-hedge-fund/agent-pipeline/pulls/1222)`
  plus a second line `PullRequest.diff too_large`.
- `isTransientGhError` does **not** treat 406 as transient, so `ghRun` throws after one attempt. That is correct. The bug is the missing fallback after that throw.
- Callers that need the string: review-routing, pre-merge SHA gate, design_gate, auto_merge_eligibility, pre-merge-openspec-archive, shipcheck. `diffFilePaths` (`core/scripts/stages/review-parsing.ts`) parses `^diff --git a\/.+ b\/(.+)$`. Prompt assembly truncates the **whole** string later (`truncateDiff` 50_000 chars). OpenSpec head-side guards read this seam, not the worktree filesystem.
- `getPrChecks` already accepts optional `GhRunOptions` for injectable `runner`. `getOpenIssues` already paginates `gh api … --paginate --slurp` and flattens page arrays. `isHttp404Signal` already classifies HTTP status syntax and rejects a bare digit token. `listPrHeadChangeDirs` already calls `gh api repos/${cfg.repo}/…` with no extra `--hostname`.
- Live files-list evidence for PR #1222 (`changed_files: 377`): `gh api repos/accidental-hedge-fund/agent-pipeline/pulls/1222/files?per_page=100 --paginate --slurp` returns JSON type `T[][]` with page lengths `[100, 100, 100, 77]`. File objects carry `filename`, `status`, `sha`, `additions`, `deletions`, `changes`, `contents_url`, optional `patch`, optional `previous_filename`. 8 `removed` files have `changes > 0` and **no** `patch` (large deleted text: `config.ts`, `gh.ts`, `pipeline.ts`, …). 131 files have no `patch` and `changes === 0`. There is no per-entry `truncated` field.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is PR #1222 (`plugin/` delete, 300+ files) 406-ing `gh pr diff` and blocking review-1. The class is: GitHub’s whole-PR diff endpoint is capped; any valid PR over that cap must still yield inspectable patch text from the shared helper, or fail closed with an incompleteness error that names the cap. A review-routing-only catch of 406, or a one-off skip of #1222, is a mole. Header-only composition for those 8 omitted text deletes would also be a mole: reviewers would not see the deleted source.
2. **Shared surfaces.** The classifier, files-list fallback, blob materialization, and 3000-file completeness check live in `getPrDiff` (`core/scripts/gh.ts`). No new `BlockerKind`, recovery recipe, or second recoverer. After the wrapper succeeds, existing review/pre-merge/shipcheck paths proceed. `isTransientGhError` stays unchanged (406 is deterministic). Metrics keep tagging `getPrDiff`.
3. **Next identical fault.** The next PR whose `gh pr diff` 406s uses the same wrapper. The unit test that fakes 406 and expects a composed files-list diff fails if the fallback is removed. No new mole issue for the same 406.

## Goals / Non-Goals

**Goals:**

- Fast path remains `gh pr diff`.
- HTTP 406 / too-large falls back to paginated List pull request files and returns composed unified-diff text when the list is complete enough to review.
- Omitted **text** patches (`patch` absent and `changes > 0`) are materialized from GitHub blob/contents bytes, not dropped.
- A 3000-file files-list ceiling is detected and fails closed.
- Returned shape stays `Promise<string>` with `diff --git` headers parseable by `diffFilePaths`.
- Fallback works without a worktree and without `git diff`.
- Tests inject a fake runner and would have caught PR #1222’s 406 **and** its 8 omitted text deletes.

**Non-Goals:**

- Changing GitHub’s 300-file diff cap or 3000-file list cap.
- Caller signature changes or per-stage moles.
- Local `git diff` as a required fallback.
- Raising or chunking the review prompt ceiling (`review-prompt-too-large`).
- Auto-merging large PRs; skipping review; splitting the `plugin/` delete PR.
- Classifying 406 as transient or adding a new blocker kind.
- Adding a Myers/JS diff library. Materialized modified files use a full-file replacement hunk (all old `-`, all new `+`).
- A new `PipelineConfig` hostname field or `gh api --hostname`. Ambient `gh` auth / `GH_HOST` already shared by every `ghRun` wrapper.

## Decisions

### 1. Fallback lives in getPrDiff, not in each caller

**Choice:** Extend `getPrDiff` only. Keep every caller on `deps.getPrDiff ?? defaultGetPrDiff`. Add optional `opts?: GhRunOptions` so tests inject `runner`, matching `getPrChecks`.

```ts
export async function getPrDiff(
  cfg: PipelineConfig,
  prNumber: number,
  opts?: GhRunOptions,
): Promise<string>
```

Production callers omit `opts`. Fast path:

```
ghRun(["pr", "diff", String(prNumber), "-R", cfg.repo], {
  ...opts,
  timeoutMs: 60_000,
  retries: 1,
  wrapperName: "getPrDiff",
})
```

`retries: 1` makes the “do not retry 406” rule local even if `isTransientGhError` later changes. Do not add 406 to `isTransientGhError`.

**Why:** One GitHub limit, one helper, many consumers. A review-only try/catch would leave pre-merge SHA hashing, design_gate, OpenSpec archive, eligibility, and shipcheck still 406-blind.

**Alternatives considered:**

- Catch 406 in review-routing only → rejected. Site mole.
- Replace `gh pr diff` with files API always → rejected. Extra pagination on every small PR.
- Local `git diff` in the managed worktree as the fallback → rejected as the required path. OpenSpec head-side guards must work when the worktree is absent.

### 2. Classify too-large with a pure exported helper

**Choice:** Export `isPrDiffTooLargeError(stderr: string): boolean`, same discipline as `isHttp404Signal` (`core/scripts/gh.ts` ~701): explicit HTTP/status syntax, never a bare digit token.

True when **either**:

- HTTP/status 406 syntax: `http 406`, `status code: 406`, `status code 406` (case-insensitive), **or**
- GitHub too-large wording (case-insensitive): `too_large`, `exceeded the maximum number of files`, `exceeded maximum number of files`, `diff is too large`, `pullrequest.diff too_large`.

False for a bare `406` token or a SHA/path/command fragment that only contains the digits `406` (example: `HTTP 500 … ref=a406bcafe`).

`getPrDiff` catches the `gh pr diff` throw, tests the classifier on `err.message` (which already includes stderr via `ghRun`), and either falls back or rethrows the original error.

**Why:** Live PR #1222 stderr uses `HTTP 406` **and** `exceeded the maximum number of files` **and** `PullRequest.diff too_large`. The earlier draft omitted the word `the` and would still match via `HTTP 406`, but wording must follow the live string. A SHA containing `406` must not trigger fallback.

**Alternatives considered:**

- Treat every 406 as too-large with no wording check → acceptable *if* scoped to `gh pr diff` stderr; wording still helps when `gh` wraps the status. This cut accepts HTTP 406 syntax **or** wording, scoped only to this helper.
- Retry 406 via `isTransientGhError` → rejected. Deterministic GitHub policy.
- Classify on file count from `gh pr view --json files` first → rejected. Extra call on every PR, and that field is truncated (live `gh pr view 1222 --json files` does not list all 377 files).

### 3. Exact files-list invocation, flatten, and host/repo targeting

**Choice:** After too-large, call the same `gh api` pagination pattern as `getOpenIssues`:

```
ghRun(
  ["api", `repos/${cfg.repo}/pulls/${prNumber}/files?per_page=100`, "--paginate", "--slurp"],
  { ...opts, timeoutMs: 120_000, wrapperName: "getPrDiff" },
)
```

Parse contract (empirically verified 2026-08-23 on PR #1222, `NO_COLOR=1`):

- `--paginate --slurp` stdout is JSON `DiffEntry[][]` (array of pages). PR #1222: 4 pages, lengths `[100, 100, 100, 77]`.
- Flatten with `(JSON.parse(stdout) as DiffEntry[][]).flat()` — same as `getOpenIssues`.
- One-page PRs still wrap as `[[...entries]]`. Flatten handles both.
- Without `--paginate`, the first page is a bare `DiffEntry[]` of at most `per_page` items and is **not** complete. Do not use that shape.
- `gh pr view --json files` is truncated. Do not use it as the fallback.

`DiffEntry` fields used (REST list-pull-request-files):

| field | required | use |
| --- | --- | --- |
| `filename` | yes | `b/` path |
| `previous_filename` | no | `a/` path on rename |
| `status` | yes | add/remove/rename/modified |
| `sha` | yes | git blob id for materialization |
| `changes` / `additions` / `deletions` | yes | omitted-text vs binary/empty |
| `patch` | no | hunk text when GitHub includes it |
| `contents_url` | no | unused when `sha` is present |

Repository / host: fast path already uses `-R cfg.repo`. Fallback uses `repos/${cfg.repo}/…`, the same targeting as `listPrHeadChangeDirs` and `getOpenIssues`. There is no `hostname` on `PipelineConfig`. Do not add `--hostname`. Both calls go through `ghRun` → `ghChildEnv()` (`NO_COLOR=1`), which is required: without it, `gh api` JSON on this host contained ANSI sequences and `JSON.parse` failed.

Invalid JSON from the files list throws (do not return `""`). An empty flattened list after a too-large fast-path failure throws (a 406 PR cannot have zero files; empty is not a substitute).

**Why:** Matches existing pagination, targeting, and uncolored-JSON law. Verified against the live 406 PR.

### 4. Compose headers; materialize omitted text; do not fake completeness

**Choice:** For each flattened entry, emit `diff --git a/<from> b/<to>` (`from` is `previous_filename` when present, else `filename`; `to` is `filename`). Filenames are emitted raw (no git quoting) so `diffFilePaths` keeps capturing the `b/` path, including spaces.

Then:

1. **`patch` present and non-empty:** append that patch text under the header. Do not blob-fetch.
2. **`patch` absent/empty and `changes === 0` (and additions/deletions === 0):** binary, empty, or mode-only. GitHub has no text hunk. Header only (optional `Binary files a/<from> and b/<to> differ`). Success for that file.
3. **`patch` absent/empty and `changes > 0` (or additions/deletions > 0):** GitHub omitted a **text** patch. This is the PR #1222 hole (8 large deletes). **Do not** succeed with header-only. Materialize without a worktree:

   - Shared blob fetch: `gh api repos/${cfg.repo}/git/blobs/${sha}` (same runner). Parse `{ content, encoding, size }`. `encoding` must be `base64`. Decode with `Buffer.from(content, "base64")` (GitHub wraps base64 with newlines; Node ignores that whitespace). NUL byte → binary (header + binary marker, no hunk). Else UTF-8 text.
   - `removed`: blob `sha` from the files entry is the deleted blob. Compose a delete unified diff (`--- a/<path>` / `+++ /dev/null` / all lines `-`). Empirically sufficient for all 8 omitted-text files on PR #1222.
   - `added`: blob `sha` is the new blob. Compose an add unified diff (`--- /dev/null` / `+++ b/<path>` / all lines `+`).
   - `modified` / `changed` / `copied`, or `renamed` with `changes > 0`: files-entry `sha` is the **new** blob. Fetch PR REST once per fallback that needs a base: `gh api repos/${cfg.repo}/pulls/${prNumber}` → capture `{ base: { sha }, head: { sha } }` (the files list is a three-dot comparison; `base.sha` is the moving target-branch tip). Then `gh api repos/${cfg.repo}/compare/{base.sha}...{head.sha}` → `.merge_base_commit.sha`. Old blob: `gh api repos/${cfg.repo}/contents/<path>?ref=<merge_base_commit.sha>` → `.sha` (path slashes unencoded, same as `listPrHeadChangeDirs`; space/odd segments `encodeURIComponent` per segment), then git blobs. Compose a full-file replacement hunk (`@@ -1,oldCount +1,newCount @@`, all old `-`, all new `+`). No third-party diff library.
   - Materialization failure (non-404 transport error, invalid JSON, non-base64, contents/blob throw): `getPrDiff` **throws** naming the PR and the path. It does not drop the file.

Do not apply prompt `truncateDiff` inside `getPrDiff`. Callers already truncate at prompt-build time. Do not invoke `git` or read a worktree.

**Why:** Issue text requires reviewers to inspect any valid PR. Live PR #1222 omits patches on 8 large deleted sources. Header-only would make review-1 “succeed” on an incomplete diff. Blob fetch is worktree-independent and already the GitHub-recommended Git Data path for large blobs. Full-file replacement hunks are reviewable without inventing a diff algorithm.

**Conflict resolved:** issue “never hard-fails on GitHub's diff-size limits” means the 300-file **whole-PR diff media type** (HTTP 406). It does not mean “return a silent partial string when the files list or a text hunk is incomplete.” Completeness failures stay visible.

**Alternatives considered:**

- Header-only for every omitted `patch` → rejected by plan review. Silent incomplete review. Would hide PR #1222’s 8 large deletes.
- Fail closed on every omitted `patch` including `changes === 0` → rejected. Binary/empty files have no text hunk; header-only is complete for those.
- Fail closed on omitted text (`changes > 0`) with no materialization → rejected. That re-STOPs PR #1222, the live site.
- Contents-API bytes for every file, skipping the files-list `patch` → rejected. Extra N round trips on files GitHub already patched.
- Local `git diff` → rejected as required. Worktree-independent guards.
- Per-file truncation inside `getPrDiff` → rejected. Today’s cap is whole-diff at prompt assembly.

### 5. GitHub’s 3000-file files-list cap fails closed

**Choice:** After flatten, if `files.length >= 3000`, throw:

```
getPrDiff: PR #<n> files list hit GitHub's 3000-file cap (received N files). Cannot claim a complete review from a partial list.
```

Do not compose a prefix. Do not append a “truncated” marker and succeed. GitHub documents “Responses include a maximum of 3000 files” and does not emit a `truncated` field on this endpoint (verified: no such key on PR #1222 entries). `>= 3000` is the detector. A PR with exactly 3000 files is indistinguishable from truncation; fail closed.

PR #1222 has 377 files, so this branch does not fire on the live site.

**Why:** Pagination to completion is not completeness. Returning 3000 of N>3000 files as a reviewable diff is the same class of silent partial the omitted-`patch` hole is.

**Conflict resolved:** the previous draft returned a trailing marker and succeeded. Plan review rejected claiming a complete review from a partial list. Fail closed.

**Alternatives considered:**

- Succeed with a trailing marker → rejected. Callers treat a returned string as the PR diff.
- Local git diff when the list is truncated → optional later; not this cut (worktree independence).
- Treat 3000 as success because “that is all GitHub will give” → rejected. Completeness is the product requirement.

### 6. Injectable runner tests in gh.test.ts

**Choice:** Co-located tests in `core/test/gh.test.ts` (or `gh-pr-diff.test.ts` if the file grows past local convention). Inject `opts.runner`. Production callers omit `opts`. Follow `getPrChecks` (`core/test/gh.test.ts` ~411): fake `GhSubprocessError.stderr`, never spawn.

Required cases (each asserts no `git` arg and no worktree path):

1. **406 composes files-list diff (biting).** `pr diff` throws `HTTP 406: … exceeded the maximum number of files (300)` / `PullRequest.diff too_large`. Files API returns `--slurp` JSON with two files (one with `patch`, one `changes === 0` without). Result contains both `diff --git` headers and the supplied patch. `pr diff` called once (`retries: 1` / not transient). **Must fail against current `getPrDiff`.**
2. **Small fast path.** `pr diff` returns a small patch. Files API never called. Passes against current helper.
3. **HTTP 404.** `pr diff` throws `HTTP 404`. Throws; files API not called.
4. **Digit-fragment 406.** `pr diff` throws `HTTP 500 … ref=a406bcafe`. Throws; files API not called. Classifier false.
5. **Multi-page flatten.** Files API stdout is `[[{filename:a}],[{filename:b}]]`. Both headers present.
6. **Rename.** `status: renamed`, `previous_filename: old.ts`, `filename: new.ts` → `diff --git a/old.ts b/new.ts`. `diffFilePaths` includes `new.ts`.
7. **Omitted text materializes.** `removed`, `changes > 0`, no `patch`. Blob API returns base64 text. Result includes a `-` line from the decoded blob. **Must fail against header-only composition.**
8. **Omitted text blob failure throws.** Same files entry; blob API throws. `getPrDiff` throws naming the path; does not return header-only.
9. **3000-cap throws.** Flattened 3000 entries (fixture may stub `filename` only). Throws cap wording; does not return a composed prefix.
10. **Files-list failure after 406 throws.** Files API throws. Error includes that failure; return is not `""`.
11. **Space path.** `filename: "foo bar.ts"` with patch → header `diff --git a/foo bar.ts b/foo bar.ts`; `diffFilePaths` includes `foo bar.ts`.
12. **Classifier unit table.** True: live PR #1222 stderr, `status code: 406`, `too_large` without digits. False: `"406"`, `error: 406 Not Found`, SHA fragment, HTTP 404.

**Why:** AC tests. Stage-level `deps.getPrDiff` fakes would not have caught this bug.

## Risks / Trade-offs

- **[Risk] Composed diff is huge and trips `review-prompt-too-large`.** → Mitigation: that is the correct next gate, already specified. This change makes the PR inspectable; it does not skip the prompt ceiling.
- **[Risk] Blob materialization adds N `gh api` calls on omitted-text files.** → Acceptable. PR #1222 needs 8 blob fetches, only on the 406 path. Small PRs pay zero extra calls. Metrics stay under wrapper name `getPrDiff`.
- **[Risk] Full-file replacement hunks for modified omitted-text are not git-minimal.** → Acceptable. Reviewers see both sides. No new diff library.
- **[Risk] `--paginate --slurp` JSON shape.** → Mitigation: flatten the same way `getOpenIssues` does. Unit-test one-page `[[…]]` and multi-page. Empirically verified on PR #1222.
- **[Risk] ANSI-colored `gh api` JSON.** → Mitigation: always go through `ghRun` / `ghChildEnv`. Do not spawn `gh` outside that env.
- **[Risk] 406 classifier false-positive.** → Mitigation: classifier is only applied to the `gh pr diff` error. Bare `406` / SHA fragment excluded. Fast path `retries: 1`.
- **[Risk] 3000-file throw re-STOPs a huge PR.** → Honest incompleteness. Distinct from the 300-file media-type cap this issue fixes. Local git enrichment is out of scope.
- **[Trade-off] Fallback patch text will not byte-match `gh pr diff` stdout** (index lines, `/dev/null` for add/delete). Acceptable: callers need headers + hunks.

## Migration Plan

1. Land `getPrDiff` fallback, classifier, materialization, 3000-cap, `GhRunOptions` seam, OpenSpec delta, and tests on this branch. After any `core/` edit, run `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
2. Merge. The next large-PR review (including a re-run of #1048 / PR #1222) uses the wrapper without a new mole issue.
3. Do not auto-merge the large PR. Review of the composed diff remains mandatory.
