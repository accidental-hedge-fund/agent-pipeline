# gh-pr-diff Specification

## Purpose
Retrieve pull-request patch text for review and pre-merge callers. Prefer `gh pr diff`. When GitHub refuses the whole-PR diff as too large, compose a compatible patch from the paginated files list so a valid PR can still be inspected. Omitted text patches are materialized from Git blobs / contents. A truncated files list is incompleteness, not a successful review.

## Requirements

### Requirement: getPrDiff SHALL use gh pr diff as the fast path

`getPrDiff` SHALL fetch the pull-request diff by invoking `gh pr diff <pr>` against the configured repository (`-R cfg.repo`). When that call succeeds, `getPrDiff` SHALL return the command stdout as a string and SHALL NOT call the pull-request files API for that retrieval.

#### Scenario: Successful small diff uses the fast path only

- **WHEN** `getPrDiff` is called for a pull request
- **AND** `gh pr diff <pr>` returns a non-empty patch
- **THEN** `getPrDiff` SHALL return that stdout string
- **AND** it SHALL NOT request `GET /repos/{owner}/{repo}/pulls/{n}/files` for that call

#### Scenario: Fast-path return type stays string patch text

- **WHEN** `gh pr diff <pr>` succeeds
- **THEN** `getPrDiff` SHALL resolve to `Promise<string>`
- **AND** the returned text SHALL be the raw unified-diff stdout (no caller-signature change)

### Requirement: getPrDiff SHALL fall back to the pull-request files list on a too-large diff

`getPrDiff` SHALL NOT throw when `gh pr diff <pr>` fails because GitHub refused the whole-PR diff as too large. It SHALL paginate `GET /repos/{owner}/{repo}/pulls/{n}/files` via `gh api repos/<cfg.repo>/pulls/<n>/files?per_page=100 --paginate --slurp` against the same `cfg.repo` as the fast path, flatten the slurp page arrays, and return a composed unified-diff string built from those file entries. Too-large SHALL include HTTP 406 status syntax (`HTTP 406`, `status code: 406`, `status code 406`) and GitHub too-large wording (`too_large`, `exceeded the maximum number of files`, `exceeded maximum number of files`, `diff is too large`, `PullRequest.diff too_large`). A SHA, path, or command fragment that only contains the digits `406` SHALL NOT by itself classify the failure as too-large. The fallback SHALL succeed without a local git worktree and SHALL NOT invoke `git diff`.

#### Scenario: HTTP 406 returns a composed files-list diff

- **WHEN** `gh pr diff <pr>` fails with HTTP 406 and too-large wording
- **AND** the files list returns at least one file entry and fewer than 3000 entries
- **THEN** `getPrDiff` SHALL return a composed unified-diff string
- **AND** it SHALL NOT throw solely because the whole-PR diff was refused

#### Scenario: Too-large fallback does not require a worktree

- **WHEN** `getPrDiff` takes the files-list fallback
- **AND** no local worktree is present
- **THEN** `getPrDiff` SHALL still return the composed string when the files list is complete
- **AND** it SHALL NOT invoke local `git diff` as a required step of that fallback

#### Scenario: Digit fragment 406 is not a too-large signal

- **WHEN** `gh pr diff <pr>` fails with a non-406 error whose text contains a SHA or path fragment `406`
- **THEN** `getPrDiff` SHALL NOT treat that failure as too-large
- **AND** it SHALL NOT call the files list solely because of that fragment
- **AND** it SHALL propagate the error to the caller

#### Scenario: Files-list call uses configured repo and slurp pagination

- **WHEN** `getPrDiff` takes the files-list fallback for PR `N` in `cfg.repo`
- **THEN** the engine SHALL invoke `gh api repos/<cfg.repo>/pulls/<N>/files?per_page=100 --paginate --slurp`
- **AND** it SHALL flatten a JSON array-of-pages into one file list before composing

### Requirement: Composed fallback diff SHALL stay compatible with existing patch-text callers

The composed fallback string SHALL include a `diff --git a/<path> b/<path>` header for every file entry returned by the files list, using `previous_filename` as the `a/` path when GitHub reports a rename. When a file entry includes a non-empty `patch` field, the composed string SHALL include that patch text under the header. Existing `diffFilePaths` and prompt `truncateDiff` callers SHALL keep consuming the returned string without a signature change.

#### Scenario: Fallback headers are parseable by diffFilePaths

- **WHEN** the files list returns files `src/a.ts` and `src/b.ts`
- **AND** `getPrDiff` composes the fallback string
- **THEN** that string SHALL contain `diff --git a/src/a.ts b/src/a.ts` and `diff --git a/src/b.ts b/src/b.ts`
- **AND** `diffFilePaths` applied to the string SHALL include `src/a.ts` and `src/b.ts`

#### Scenario: Rename uses previous_filename on the a/ side

- **WHEN** a files-list entry has `status` `renamed`, `previous_filename` `old.ts`, and `filename` `new.ts`
- **THEN** the composed string SHALL include `diff --git a/old.ts b/new.ts`

#### Scenario: Space-containing path stays parseable

- **WHEN** a files-list entry has `filename` `foo bar.ts` and a `patch` field
- **THEN** the composed string SHALL include `diff --git a/foo bar.ts b/foo bar.ts`
- **AND** `diffFilePaths` applied to the string SHALL include `foo bar.ts`

### Requirement: getPrDiff SHALL materialize omitted text patches and SHALL NOT present them as complete header-only diffs

When a files-list entry omits `patch` (or `patch` is empty) and reports a non-zero text change (`changes > 0` or `additions > 0` or `deletions > 0`), `getPrDiff` SHALL materialize reviewable hunk text from the Git blobs API (`GET /repos/{owner}/{repo}/git/blobs/{sha}`) and, for modified/renamed-with-edits entries, the contents API at the PR comparison merge-base SHA. `getPrDiff` SHALL use `base.sha` and `head.sha` from the pinned matching before/after pair (see pin requirement) and SHALL use `merge_base_commit.sha` from `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}` of that captured pair as the contents ref. It SHALL NOT re-read the live pull request after the files list returns in order to pick a later head for merge-base. It SHALL NOT use the base-branch tip (`base.sha`) as the old-blob ref when that SHA differs from the merge base. Materialization SHALL NOT require a local worktree. When materialization fails, `getPrDiff` SHALL throw an Error that names the pull request and the path. `getPrDiff` SHALL NOT return a header-only string as success for that file. When a files-list entry omits `patch` and reports zero changes, `getPrDiff` SHALL emit the path header (binary / empty / mode-only) and SHALL still resolve successfully.

#### Scenario: Missing per-file patch with zero changes contributes a path header

- **WHEN** a files-list entry has `filename` `bin/app.bin`, no `patch` field, and `changes` `0`
- **THEN** the composed string SHALL include `diff --git a/bin/app.bin b/bin/app.bin`
- **AND** `getPrDiff` SHALL still resolve successfully

#### Scenario: Omitted text patch is materialized from the git blob

- **WHEN** a files-list entry has `status` `removed`, `filename` `src/big.ts`, `changes` greater than `0`, and no `patch` field
- **AND** `GET /repos/{owner}/{repo}/git/blobs/{sha}` returns base64-encoded text containing a source line
- **THEN** the composed string SHALL include `diff --git a/src/big.ts b/src/big.ts`
- **AND** it SHALL include that source line as a deleted unified-diff line
- **AND** `getPrDiff` SHALL NOT succeed with header-only output for that file

#### Scenario: Omitted text patch blob failure fails closed

- **WHEN** a files-list entry omits `patch` and reports `changes > 0`
- **AND** the git-blob retrieval for that file fails
- **THEN** `getPrDiff` SHALL throw an Error that names the path
- **AND** it SHALL NOT return a composed string that drops that file's hunk

#### Scenario: Materialized modified omitted patch uses the PR merge base

- **WHEN** a files-list entry has `status` `modified`, omits `patch`, and reports `changes > 0`
- **AND** the pull request's `base.sha` (base-branch tip) differs from the compare `merge_base_commit.sha`
- **THEN** `getPrDiff` SHALL fetch old contents at the merge-base SHA
- **AND** the composed hunk SHALL include the merge-base file text as deleted lines
- **AND** it SHALL NOT use the base-branch tip as the old-blob ref

### Requirement: getPrDiff SHALL pin files-list fallback collection to one PR revision

`getPrDiff` SHALL pin the files-list fallback to one pull-request revision. Before listing files it SHALL read `base.sha` and `head.sha` from `GET /repos/{owner}/{repo}/pulls/{n}`. After pagination it SHALL read `base.sha` and `head.sha` again from the same endpoint. It SHALL compose the fallback diff only when those two pairs are identical. It SHALL derive the merge-base contents ref from `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}` of that captured pair. It SHALL NOT compose a hunk that pairs files-list blob SHAs from one head with a merge-base derived from a different head. When the pair changes, `getPrDiff` SHALL retry the before-list-after collection, up to three attempts. If the pair still differs after those attempts, `getPrDiff` SHALL throw an Error that names the pull request and that the PR moved during collection. It SHALL NOT return a mixed-revision diff as success.

#### Scenario: Head moves from H1 to H2 after the files list returns

- **WHEN** `getPrDiff` takes the files-list fallback
- **AND** the files list returns blob SHAs for head H1
- **AND** a later pull-request read returns head H2
- **THEN** `getPrDiff` SHALL NOT return a hunk that pairs H2's merge-base with H1 blob SHAs
- **AND** it SHALL retry collection until a before/after pair matches or fail closed

#### Scenario: Persistent movement during collection fails closed

- **WHEN** `getPrDiff` takes the files-list fallback
- **AND** `base.sha` or `head.sha` differs between the before-list and after-list reads on every attempt
- **THEN** `getPrDiff` SHALL throw an Error that includes that the PR moved
- **AND** it SHALL NOT return a composed mixed-revision diff

### Requirement: getPrDiff SHALL fail closed when the files list hits GitHub's 3000-file cap

After flattening the paginated files list, if the entry count is greater than or equal to 3000, `getPrDiff` SHALL throw an Error that names the pull request and GitHub's 3000-file files-list cap. It SHALL NOT return a composed prefix of that list as a complete diff.

#### Scenario: Flattened list of 3000 files throws

- **WHEN** `gh pr diff <pr>` fails as too-large
- **AND** the files-list fallback flattens to 3000 file entries
- **THEN** `getPrDiff` SHALL throw an Error that includes `3000`
- **AND** it SHALL NOT return a unified-diff string for that retrieval

### Requirement: Non-too-large getPrDiff failures SHALL stay visible

`getPrDiff` SHALL throw when `gh pr diff` fails for a reason other than too-large. After a too-large fast-path failure, `getPrDiff` SHALL throw if the files-list retrieval itself fails. `getPrDiff` SHALL NOT return an empty string as a substitute for a failed retrieval. HTTP 406 / too-large SHALL remain a deterministic error: `ghRun` SHALL NOT retry the refused `gh pr diff` as a transient blip before the fallback.

#### Scenario: Deterministic 404 still throws

- **WHEN** `gh pr diff <pr>` fails with HTTP 404
- **THEN** `getPrDiff` SHALL throw an Error that includes the `gh` stderr text
- **AND** it SHALL NOT call the files list for that 404

#### Scenario: Files-list failure after 406 still throws

- **WHEN** `gh pr diff <pr>` fails as too-large
- **AND** the subsequent files-list retrieval fails
- **THEN** `getPrDiff` SHALL throw an Error that includes the files-list failure
- **AND** it SHALL NOT return an empty string

#### Scenario: Too-large is not retried as transient

- **WHEN** `gh pr diff <pr>` fails with HTTP 406 too-large
- **THEN** the engine SHALL NOT retry that `gh pr diff` as a transient `ghRun` error
- **AND** it SHALL proceed to the files-list fallback after the first too-large failure

### Requirement: getPrDiff too-large fallback SHALL be regression-tested via injectable I/O

Automated checks SHALL fail if a fake `gh pr diff` HTTP 406 / too-large result does not produce a composed files-list diff. A second check SHALL fail if a successful small `gh pr diff` result still calls the files list. Checks SHALL also fail if omitted-text files (`patch` absent, `changes > 0`) succeed as header-only, if a modified omitted-text hunk is synthesized from the base-branch tip when the merge base differs, if a 3000-file flattened list returns a composed prefix, if the fallback invokes `git`, or if an H1 files-list snapshot is composed against an H2 merge-base when the head moves during collection. Tests SHALL inject the `gh` runner (or equivalent `GhRunOptions` seam). Tests SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Regression fails if 406 does not compose a files-list diff

- **WHEN** the automated checks inject a runner whose `gh pr diff` fails with HTTP 406 too-large
- **AND** the injected files list returns at least one file with a patch
- **AND** `getPrDiff` throws or returns a string that lacks `diff --git` headers for those files
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if a small diff still hits the files API

- **WHEN** the automated checks inject a runner whose `gh pr diff` succeeds with a small patch
- **AND** `getPrDiff` still requests the pull-request files list
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if omitted text is dropped

- **WHEN** the automated checks inject a 406 runner and a files-list entry with no `patch` and `changes > 0`
- **AND** the injected blob API returns file text
- **AND** `getPrDiff` returns a string that lacks that file text
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if omitted modified hunk uses the base tip

- **WHEN** the automated checks inject a 406 runner and a modified omitted-text file
- **AND** the injected PR `base.sha` differs from compare `merge_base_commit.sha`
- **AND** the injected merge-base and base-tip blobs contain different text
- **AND** `getPrDiff` returns a string that includes the base-tip text or lacks the merge-base text
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if H1 files compose with an H2 merge-base

- **WHEN** the automated checks inject a 406 runner and a modified omitted-text file
- **AND** the files list first returns H1 blob SHAs
- **AND** a subsequent PR read returns H2
- **AND** `getPrDiff` returns a hunk that pairs H2 merge-base text with H1 blob text
- **THEN** the checks SHALL fail
