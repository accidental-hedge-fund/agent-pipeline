# fix-commit-lockfile-inclusion Specification

## Purpose
TBD - created by archiving change fix-commit-lockfile-inclusion. Update Purpose after archive.
## Requirements
### Requirement: The fix-round commit step SHALL fold uncommitted lock-file side-effects into the round commit

After a fix round's harness produces at least one new commit in the worktree, the fix stage SHALL detect
uncommitted lock-file changes and fold them into the round's HEAD commit before the format and test gates
run, so the worktree carries no uncommitted lock-file change when those gates certify it. A recognized lock
file is any file whose basename is `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`, at any directory
depth in the worktree. The inclusion SHALL amend the round's HEAD commit (`git commit --amend --no-edit`)
rather than create a separate commit, so the round commit's message and its `Issue:` / `Pipeline-Run:`
trailers are preserved.

#### Scenario: Fix harness commits source and leaves package-lock.json dirty

- **WHEN** a fix round harness exits with a new commit (`headBefore !== headAfter`)
- **AND** `git status --porcelain` in the worktree reports a modified `core/package-lock.json`
- **THEN** the fix stage SHALL stage `core/package-lock.json` and amend the round's HEAD commit to include it
- **AND** after the step `git status --porcelain` SHALL report no uncommitted `**/package-lock.json`,
  `**/yarn.lock`, or `**/pnpm-lock.yaml` change
- **AND** the amended commit SHALL retain its original subject and its `Issue:` and `Pipeline-Run:` trailers
- **AND** no separate commit SHALL be created for the lock file

#### Scenario: Nested lock file is recognized and included

- **WHEN** a fix round leaves an uncommitted lock file at a nested path such as
  `plugin/.claude/skills/pipeline/core/package-lock.json`
- **THEN** the fix stage SHALL recognize it as a lock file and fold it into the round commit
- **AND** after the step the worktree SHALL carry no uncommitted lock-file change

#### Scenario: Inclusion runs before the format and test gates

- **WHEN** a fix round leaves an uncommitted lock file after committing source
- **THEN** the lock-file inclusion SHALL run before `runFormatAndTestGates`
- **AND** the format gate's pre-flight dirty check and the test gate's pre-run dirty check SHALL observe a
  worktree with no uncommitted lock-file change and SHALL NOT block on it

### Requirement: The fix-round commit step SHALL be behavior-preserving when no lock file changed

The fix stage SHALL perform no additional staging, amend, or commit for lock files when a fix round produces
a commit and the worktree contains no uncommitted lock-file change; the round SHALL proceed exactly as it did
before this capability.

#### Scenario: Clean worktree after fix commit — no amend occurs

- **WHEN** a fix round harness exits with a new commit
- **AND** `git status --porcelain` reports no `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` change
- **THEN** the fix stage SHALL NOT stage, amend, or create any commit for lock files
- **AND** the round commit's SHA and message SHALL be unchanged by this step

### Requirement: The fix-round commit step SHALL auto-include only lock files

The lock-file inclusion SHALL stage only recognized lock-file paths. Any uncommitted non-lock-file path SHALL
be left untouched by this step, so the existing dirty-worktree handling (the format-gate pre-flight and
test-gate pre-run dirty blocks) applies to it unchanged.

#### Scenario: Mixed dirt — only the lock file is folded in

- **WHEN** a fix round leaves both an uncommitted `core/package-lock.json` and an uncommitted
  `core/scripts/foo.ts`
- **THEN** the fix stage SHALL stage and commit only `core/package-lock.json`
- **AND** `core/scripts/foo.ts` SHALL remain uncommitted in the worktree
- **AND** the pre-gate dirty block SHALL still fire on the remaining uncommitted `core/scripts/foo.ts`

#### Scenario: Pre-staged non-lock file is not swept into the amend

- **WHEN** a fix round leaves a modified `core/package-lock.json` in the worktree (unstaged)
- **AND** `core/scripts/foo.ts` is already staged in the index (e.g., `M  core/scripts/foo.ts`)
- **THEN** the fix stage SHALL temporarily unstage `core/scripts/foo.ts` before amending
- **AND** SHALL stage and amend only `core/package-lock.json`
- **AND** SHALL restore `core/scripts/foo.ts` to staged after the amend
- **AND** the amended HEAD commit SHALL NOT contain `core/scripts/foo.ts`

### Requirement: The lock-file inclusion behavior SHALL be injectable and have a biting regression test

The lock-file inclusion logic SHALL accept injectable git seams (a porcelain-status reader, a path-scoped
stager, an amend-no-edit committer, a staged-path restorer, and a cached-removal committer) so unit tests
exercise it with fakes and perform no real git, network, or subprocess call. The test suite SHALL include a
regression test that drives "fix harness committed source and left `core/package-lock.json` dirty" and
asserts the lock file is folded into the round commit and the worktree is clean of lock-file changes
afterward. The test SHALL bite: with the inclusion step removed, the same input SHALL leave the lock file
uncommitted.

#### Scenario: Unit test exercises the dirty-lock inclusion path with fakes

- **WHEN** the fake porcelain-status reader reports a modified `core/package-lock.json`
- **THEN** the test SHALL assert the path-scoped stager is called with only the lock path
- **AND** SHALL assert the amend-no-edit committer is called
- **AND** SHALL assert no real git subprocess is invoked

#### Scenario: Regression test bites without the inclusion step

- **WHEN** the lock-file inclusion step is removed and the same fix round leaves `core/package-lock.json`
  dirty after committing source
- **THEN** the test SHALL observe the lock file remaining uncommitted (worktree dirty)
- **AND** the test SHALL fail, proving it guards the fix

