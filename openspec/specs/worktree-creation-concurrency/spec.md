# worktree-creation-concurrency Specification

## Purpose
TBD - created by archiving change concurrent-worktree-add-lock. Update Purpose after archive.
## Requirements
### Requirement: Concurrent worktree creation is serialized by a per-repo mutex
`createWorktree` SHALL acquire a cross-process per-repo mutex at `/tmp/pipeline-wt-<hash>.lock` (where `<hash>` is an 8-character hex prefix of the SHA-1 of the canonical Git common directory, resolved via `git -C cfg.repo_dir rev-parse --path-format=absolute --git-common-dir`) before invoking `git worktree add`, and SHALL release it immediately after the subprocess completes. Using the common directory (rather than `cfg.repo_dir`) ensures that two pipeline runs started from different linked worktrees of the same repository share the same mutex file. If the mutex file exists and its recorded PID is dead or invalid, the mutex SHALL be treated as stale, removed, and re-acquired without error. The stale-reclaim sequence (read PID, unlink, re-acquire) SHALL be serialized by a short-lived reclaimer lock (`<mutex-path>.reclaim`) so that two concurrent reclaimers cannot both unlink and race to reacquire.

#### Scenario: two concurrent calls serialize
- **WHEN** two pipeline runs call `createWorktree` for different issues at the same moment
- **THEN** one run SHALL hold the mutex and proceed with `git worktree add` while the other waits
- **AND** both `git worktree add` calls SHALL complete without `.git/config.lock` contention

#### Scenario: stale mutex is reclaimed
- **WHEN** the mutex lock file exists with a PID that is no longer running
- **THEN** `createWorktree` SHALL remove the stale file, acquire the mutex, and proceed without error

#### Scenario: mutex is released after git worktree add completes
- **WHEN** `git worktree add` finishes (success or failure)
- **THEN** the mutex lock file SHALL be removed before `createWorktree` returns or throws

### Requirement: git worktree add is retried on transient config-lock contention
When `git worktree add` exits non-zero and the stderr output contains `"could not lock config file"`, `createWorktree` SHALL retry the command up to **3** times with exponential backoff (base interval approximately 200 ms, doubling each attempt). If all retries fail, `createWorktree` SHALL throw with the final stderr as the error message.

#### Scenario: retry succeeds on second attempt
- **WHEN** the first `git worktree add` fails with `.git/config.lock` in stderr and the second attempt succeeds
- **THEN** `createWorktree` SHALL return normally without throwing

#### Scenario: retries exhausted
- **WHEN** all retry attempts fail with `.git/config.lock` contention
- **THEN** `createWorktree` SHALL throw an error containing the final stderr

#### Scenario: non-lock failures are not retried
- **WHEN** `git worktree add` exits non-zero for a reason unrelated to `.git/config.lock` (e.g., branch already exists)
- **THEN** `createWorktree` SHALL throw immediately without retrying

### Requirement: Mutex and retry logic are injectable for testing
The mutex acquire, mutex release, sleep, and Git common directory resolution functions used in `createWorktree` SHALL be injectable via the existing `CreateWorktreeDeps` interface so that unit tests can simulate lock contention, stale files, and retry sequencing without spawning real processes or waiting on real timers.

#### Scenario: unit test simulates retry success
- **WHEN** injected deps make the first `gitCmd` return a `.git/config.lock` error and the second return success
- **THEN** the test SHALL confirm `createWorktree` retried and returned normally, with no real sleep

#### Scenario: unit test simulates mutex stale recovery
- **WHEN** injected deps provide a stale mutex file (dead PID) and a healthy `gitCmd`
- **THEN** the test SHALL confirm the stale file was removed and `createWorktree` succeeded

