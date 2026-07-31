# implement-commit-lockfile-inclusion Specification

## Purpose
TBD - created by archiving change implement-path-lockfile-fold. Update Purpose after archive.
## Requirements
### Requirement: Post-implementation path SHALL fold uncommitted lock-file side-effects before format and test gates

The post-implementation path for stage `implementing` SHALL fold uncommitted recognized
lock-file side-effects into HEAD before format and test gates run. This covers the first
handoff after a successful implement harness and the dispatch resume path that re-enters
`implementing` with commits ahead of base. A recognized lock file is any path whose basename
is `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`, at any directory depth. Inclusion
SHALL amend HEAD via `git commit --amend --no-edit` (or the existing
`includeLockfileSideEffects` helper that implements that contract), preserving the commit
message and its `Issue:` / `Pipeline-Run:` trailers, and SHALL NOT create a separate lock-only
commit. The implement path SHALL reuse the same lock recognition and fold semantics as the fix
path's lock-file inclusion capability (`fix-commit-lockfile-inclusion` / #358).

#### Scenario: Implement advances HEAD and leaves package-lock.json untracked

- **WHEN** the implement harness exits with HEAD advanced relative to the pre-implement tip
- **AND** `git status --porcelain` reports an untracked or modified `package-lock.json` (root
  or nested)
- **AND** the post-implementation path runs before format/test gates
- **THEN** the pipeline SHALL stage that lock path and amend HEAD to include it
- **AND** after the fold, format/test pre-dirty checks SHALL NOT observe that lock path as
  uncommitted dirt
- **AND** the amended commit SHALL retain its original subject and its `Issue:` and
  `Pipeline-Run:` trailers
- **AND** no separate commit SHALL be created solely for the lock file

#### Scenario: Resume at implementing with leftover lock dirt folds before gates

- **WHEN** the orchestrator resumes post-implementation steps at stage `implementing` with
  commits ahead of base
- **AND** the worktree has an uncommitted recognized lock file
- **THEN** the lock-file fold SHALL run before format/test gates
- **AND** the testgate pre-dirty check SHALL NOT block solely because of that lock file

#### Scenario: Inclusion runs before runFormatAndTestGates on the implement path

- **WHEN** post-implementation steps are about to certify the worktree via format and test gates
- **AND** at least one recognized lock file is uncommitted
- **THEN** the lock-file inclusion SHALL complete before `runFormatAndTestGates` is invoked
- **AND** the format gate's pre-flight dirty check and the test gate's pre-run dirty check
  SHALL observe no uncommitted recognized lock-file change from that leftover

### Requirement: Implement lock-file fold SHALL be behavior-preserving when no lock file is dirty

The implement-path lock-file fold SHALL perform no staging, amend, or commit when the worktree
contains no uncommitted recognized lock-file change; subsequent gates proceed exactly as they
did before this capability.

#### Scenario: Clean of locks after implement — no amend occurs

- **WHEN** post-implementation steps run
- **AND** `git status --porcelain` reports no `package-lock.json`, `yarn.lock`, or
  `pnpm-lock.yaml` change
- **THEN** the implement lock-file fold SHALL NOT stage, amend, or create any commit
- **AND** HEAD's SHA and message SHALL be unchanged by this step

### Requirement: Implement lock-file fold SHALL auto-include only lock files

The implement-path lock-file inclusion SHALL stage only recognized lock-file paths. Any
uncommitted non-lock path SHALL be left untouched so the existing dirty-worktree handling
(format-gate pre-flight and test-gate pre-run dirty blocks) still applies to it.

#### Scenario: Mixed dirt after implement — only the lock is folded

- **WHEN** post-implementation steps run
- **AND** the worktree has both an uncommitted `package-lock.json` and an uncommitted
  non-lock path such as `core/scripts/foo.ts`
- **THEN** the fold SHALL include only the lock path in the amend
- **AND** the non-lock path SHALL remain uncommitted
- **AND** the pre-gate dirty block SHALL still fire on the remaining non-lock path

### Requirement: Implement lock-file fold SHALL be injectable and have a biting regression test

The implement-path call to lock-file inclusion SHALL accept injectable seams (directly or via
the existing `includeLockfileSideEffects` deps) so unit tests exercise the path with fakes and
perform no real git, network, or subprocess call. The test suite SHALL include a regression
that drives implement-shaped (or `resumeFromImplementing`-shaped) progress with an uncommitted
recognized lock file and asserts the fold runs before the format/test gates runner. The test
SHALL bite: without the fold call, the same setup SHALL leave the lock uncommitted for the
gates (or the gates runner is reached without the fold seam having been invoked).

#### Scenario: Unit test exercises implement-path dirty-lock fold with fakes

- **WHEN** a fake porcelain-status reader reports an uncommitted `package-lock.json`
- **AND** the post-implementation path is driven with injectable fold and gates seams
- **THEN** the test SHALL assert the fold seam is invoked before the gates runner
- **AND** SHALL assert no real git subprocess is required for that assertion path

#### Scenario: Regression test bites without the implement-path fold

- **WHEN** the implement-path lock-file fold call is removed
- **AND** the same implement-shaped input leaves `package-lock.json` dirty after HEAD advanced
- **THEN** the regression test SHALL fail (lock remains visible as pre-gate dirt, or fold was
  never invoked), proving it guards the implement path

