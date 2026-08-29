## MODIFIED Requirements

### Requirement: getPrDiff SHALL materialize omitted text patches and SHALL NOT present them as complete header-only diffs

When a files-list entry omits `patch` (or `patch` is empty) and reports a non-zero text change (`changes > 0` or `additions > 0` or `deletions > 0`), `getPrDiff` SHALL materialize reviewable hunk text from the Git blobs API (`GET /repos/{owner}/{repo}/git/blobs/{sha}`) and, for modified/renamed-with-edits entries, the contents API at the PR comparison merge-base SHA. `getPrDiff` SHALL use `base.sha` and `head.sha` from the pinned matching before/after pair (see pin requirement) and SHALL use `merge_base_commit.sha` from `GET /repos/{owner}/{repo}/compare/{base.sha}...{head.sha}` of that captured pair as the contents ref. It SHALL NOT re-read the live pull request after the files list returns in order to pick a later head for merge-base. It SHALL NOT use the base-branch tip (`base.sha`) as the old-blob ref when that SHA differs from the merge base. Materialization SHALL NOT require a local worktree. When materialization fails, `getPrDiff` SHALL throw an Error that names the pull request and the path. `getPrDiff` SHALL NOT return a header-only string as success for that file. When a files-list entry omits `patch`, has `status` `modified`, and reports zero line changes, `getPrDiff` SHALL throw an Error that names the pull request and path because the entry may represent a file-mode change and the files-list payload has no old/new mode metadata. It SHALL NOT return a header-only diff as success. This fail-closed behavior also covers ambiguous binary modifications. Other patch-less zero-change statuses SHALL continue to emit the path header and resolve successfully.

#### Scenario: Patch-less zero-line modified entry fails closed

- **WHEN** a files-list entry has `status` `modified`, `filename` `bin/app.bin`, no `patch` field, and `additions`, `deletions`, and `changes` all equal `0`
- **THEN** `getPrDiff` SHALL throw an Error that names the pull request and `bin/app.bin` as a possible file-mode change
- **AND** it SHALL NOT return a header-only diff as success

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

### Requirement: getPrDiff too-large fallback SHALL be regression-tested via injectable I/O

Automated checks SHALL fail if a fake `gh pr diff` HTTP 406 / too-large result does not produce a composed files-list diff. A second check SHALL fail if a successful small `gh pr diff` result still calls the files list. Checks SHALL also fail if omitted-text files (`patch` absent, `changes > 0`) succeed as header-only, if a patch-less zero-line `modified` entry resolves successfully, if a modified omitted-text hunk is synthesized from the base-branch tip when the merge base differs, if a 3000-file flattened list returns a composed prefix, if the fallback invokes `git`, or if an H1 files-list snapshot is composed against an H2 merge-base when the head moves during collection. Tests SHALL inject the `gh` runner (or equivalent `GhRunOptions` seam). Tests SHALL NOT perform real network, git, or subprocess calls.

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

#### Scenario: Regression fails if a patch-less zero-line modified entry succeeds

- **WHEN** the automated checks inject a 406 runner and a files-list entry with `status` `modified`, no `patch`, and zero `additions`, `deletions`, and `changes`
- **AND** `getPrDiff` returns any diff instead of throwing an Error that names the pull request and path
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
