## Purpose

Retrieve pull-request patch text for review and pre-merge callers. Prefer `gh pr diff`. When GitHub refuses the whole-PR diff as too large, compose a compatible patch from the paginated files list so a valid PR can still be inspected.

## ADDED Requirements

### Requirement: getPrDiff SHALL use gh pr diff as the fast path

`getPrDiff` SHALL fetch the pull-request diff by invoking `gh pr diff <pr>` against the configured repository. When that call succeeds, `getPrDiff` SHALL return the command stdout as a string and SHALL NOT call the pull-request files API for that retrieval.

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

`getPrDiff` SHALL NOT throw when `gh pr diff <pr>` fails because GitHub refused the whole-PR diff as too large. It SHALL paginate `GET /repos/{owner}/{repo}/pulls/{n}/files` to completion and SHALL return a composed unified-diff string built from those file entries. Too-large SHALL include HTTP 406 status syntax and GitHub too-large wording (`too_large`, `exceeded maximum number of files`, `diff is too large`, `PullRequest.diff too_large`). A SHA, path, or command fragment that only contains the digits `406` SHALL NOT by itself classify the failure as too-large. The fallback SHALL succeed without a local git worktree.

#### Scenario: HTTP 406 returns a composed files-list diff

- **WHEN** `gh pr diff <pr>` fails with HTTP 406 and too-large wording
- **AND** the files list returns at least one file entry
- **THEN** `getPrDiff` SHALL return a composed unified-diff string
- **AND** it SHALL NOT throw solely because the whole-PR diff was refused

#### Scenario: Too-large fallback does not require a worktree

- **WHEN** `getPrDiff` takes the files-list fallback
- **AND** no local worktree is present
- **THEN** `getPrDiff` SHALL still return the composed string
- **AND** it SHALL NOT invoke local `git diff` as a required step of that fallback

#### Scenario: Digit fragment 406 is not a too-large signal

- **WHEN** `gh pr diff <pr>` fails with a non-406 error whose text contains a SHA or path fragment `406`
- **THEN** `getPrDiff` SHALL NOT treat that failure as too-large
- **AND** it SHALL NOT call the files list solely because of that fragment
- **AND** it SHALL propagate the error to the caller

### Requirement: Composed fallback diff SHALL stay compatible with existing patch-text callers

The composed fallback string SHALL include a `diff --git a/<path> b/<path>` header for every file entry returned by the files list, using `previous_filename` as the `a/` path when GitHub reports a rename. When a file entry includes a `patch` field, the composed string SHALL include that patch text under the header. When a file entry omits `patch` (binary, empty, or GitHub-truncated), the composed string SHALL still include the header so path extraction still sees the file. Existing `diffFilePaths` and prompt `truncateDiff` callers SHALL keep consuming the returned string without a signature change.

#### Scenario: Fallback headers are parseable by diffFilePaths

- **WHEN** the files list returns files `src/a.ts` and `src/b.ts`
- **AND** `getPrDiff` composes the fallback string
- **THEN** that string SHALL contain `diff --git a/src/a.ts b/src/a.ts` and `diff --git a/src/b.ts b/src/b.ts`
- **AND** `diffFilePaths` applied to the string SHALL include `src/a.ts` and `src/b.ts`

#### Scenario: Missing per-file patch still contributes a path header

- **WHEN** a files-list entry has `filename` `bin/app.bin` and no `patch` field
- **THEN** the composed string SHALL include `diff --git a/bin/app.bin b/bin/app.bin`
- **AND** `getPrDiff` SHALL still resolve successfully

#### Scenario: Rename uses previous_filename on the a/ side

- **WHEN** a files-list entry has `status` `renamed`, `previous_filename` `old.ts`, and `filename` `new.ts`
- **THEN** the composed string SHALL include `diff --git a/old.ts b/new.ts`

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

Automated checks SHALL fail if a fake `gh pr diff` HTTP 406 / too-large result does not produce a composed files-list diff. A second check SHALL fail if a successful small `gh pr diff` result still calls the files list. Tests SHALL inject the `gh` runner (or equivalent `GhRunOptions` seam). Tests SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Regression fails if 406 does not compose a files-list diff

- **WHEN** the automated checks inject a runner whose `gh pr diff` fails with HTTP 406 too-large
- **AND** the injected files list returns at least one file with a patch
- **AND** `getPrDiff` throws or returns a string that lacks `diff --git` headers for those files
- **THEN** the checks SHALL fail

#### Scenario: Regression fails if a small diff still hits the files API

- **WHEN** the automated checks inject a runner whose `gh pr diff` succeeds with a small patch
- **AND** `getPrDiff` still requests the pull-request files list
- **THEN** the checks SHALL fail
}
