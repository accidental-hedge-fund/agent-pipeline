# worktree-creation-concurrency Specification

## Purpose
TBD - created by archiving change concurrent-worktree-add-lock. Update Purpose after archive.
## Requirements
### Requirement: Concurrent worktree creation is serialized by a per-repo mutex

`createWorktree` SHALL acquire a cross-process per-repo mutex at `/tmp/pipeline-wt-<hash>.lock` (where `<hash>` is an 8-character hex prefix of the SHA-1 of the canonical Git common directory, resolved via `git -C cfg.repo_dir rev-parse --path-format=absolute --git-common-dir`) before invoking the base-branch fetch (`git fetch origin <base_branch>`), and SHALL hold the mutex across the base-branch fetch, the pre-add stale-branch cleanup (`git branch -D`), and `git worktree add`, releasing it immediately after `git worktree add` completes (success or failure). Extending the critical section over the fetch — not just `git worktree add` — is what serializes concurrent fetches of the same repo so they cannot race on the `refs/remotes/origin/<base_branch>` ref lock. Using the common directory (rather than `cfg.repo_dir`) ensures that two pipeline runs started from different linked worktrees of the same repository share the same mutex file. If the mutex file exists and its recorded PID is dead or invalid, the mutex SHALL be treated as stale, removed, and re-acquired without error. The stale-reclaim sequence (read PID, unlink, re-acquire) SHALL be serialized by a short-lived reclaimer lock (`<mutex-path>.reclaim`) so that two concurrent reclaimers cannot both unlink and race to reacquire. The mutex wait timeout SHALL be large enough that a single live holder performing both its base-branch fetch and its `git worktree add` cannot outlast a waiter (i.e. it SHALL account for both git subprocess timeouts plus margin).

#### Scenario: two concurrent calls serialize

- **WHEN** two pipeline runs call `createWorktree` for different issues at the same moment
- **THEN** one run SHALL hold the mutex and proceed with its base-branch fetch and `git worktree add` while the other waits
- **AND** neither run SHALL fail with `.git/config.lock` contention nor with `refs/remotes/origin/<base_branch>` ref-lock contention caused by the other run

#### Scenario: fetch runs inside the critical section

- **WHEN** `createWorktree` is invoked
- **THEN** the per-repo mutex SHALL be acquired before the first `git fetch origin <base_branch>` call
- **AND** it SHALL NOT be released until after `git worktree add` completes (success or failure)

#### Scenario: stale mutex is reclaimed

- **WHEN** the mutex lock file exists with a PID that is no longer running
- **THEN** `createWorktree` SHALL remove the stale file, acquire the mutex, and proceed without error

#### Scenario: mutex is released after git worktree add completes

- **WHEN** `git worktree add` finishes (success or failure)
- **THEN** the mutex lock file SHALL be removed before `createWorktree` returns or throws

#### Scenario: mutex is released when the fetch fails

- **WHEN** the base-branch fetch throws (e.g. exhausted ref-lock retries or a non-contention failure) before `git worktree add` runs
- **THEN** the mutex lock file SHALL be removed before `createWorktree` throws, leaking no lock

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

The mutex acquire, mutex release, sleep, Git common directory resolution, and backoff jitter source functions used in `createWorktree` SHALL be injectable via the existing `CreateWorktreeDeps` interface so that unit tests can simulate lock contention, stale files, ref-lock contention on the fetch, and retry sequencing without spawning real processes or waiting on real timers. The fetch retry path SHALL NOT call `Math.random` directly; it SHALL draw jitter from the injectable source so tests are deterministic.

#### Scenario: unit test simulates retry success

- **WHEN** injected deps make the first `gitCmd` `git worktree add` return a `.git/config.lock` error and the second return success
- **THEN** the test SHALL confirm `createWorktree` retried and returned normally, with no real sleep

#### Scenario: unit test simulates mutex stale recovery

- **WHEN** injected deps provide a stale mutex file (dead PID) and a healthy `gitCmd`
- **THEN** the test SHALL confirm the stale file was removed and `createWorktree` succeeded

#### Scenario: unit test simulates fetch ref-lock retry

- **WHEN** injected deps make the first `gitCmd` `git fetch` return a ref-lock error and the second return success, with injected `sleep` and `jitter`
- **THEN** the test SHALL confirm `createWorktree` retried the fetch and returned normally, using no real network, git, or timers

### Requirement: The base-branch fetch is retried on transient ref-lock contention

When `git fetch origin <base_branch>` exits non-zero and its stderr contains the ref-lock contention signature (the substring `cannot lock ref` or `unable to update local ref`), `createWorktree` SHALL retry the fetch up to a small bounded number of attempts with exponential backoff plus randomized jitter (base interval approximately 200 ms). This retry is defense against a ref lock left by a git process the per-repo mutex cannot coordinate (e.g. a crashed pipeline git or a developer's manual `git fetch`); the mutex remains the primary serialization mechanism. A fetch that exits non-zero for any reason NOT matching the ref-lock signature (authentication, network, missing remote, unknown base branch) SHALL cause `createWorktree` to throw immediately with the underlying stderr — the retry SHALL be scoped strictly to the ref-lock signature and SHALL NOT be a catch-all on non-zero exit. If all retry attempts fail with ref-lock contention, `createWorktree` SHALL throw with the final stderr.

#### Scenario: fetch retry succeeds after contention

- **WHEN** the first `git fetch origin <base_branch>` fails with `cannot lock ref 'refs/remotes/origin/<base>'` / `unable to update local ref` and a later attempt succeeds
- **THEN** `createWorktree` SHALL return normally without throwing and SHALL proceed to `git worktree add`

#### Scenario: non-contention fetch failure fails fast

- **WHEN** `git fetch origin <base_branch>` exits non-zero with stderr that does not match the ref-lock signature (e.g. `Could not resolve host` or `could not read Username`)
- **THEN** `createWorktree` SHALL throw immediately with the underlying stderr and SHALL NOT retry the fetch

#### Scenario: fetch ref-lock retries exhausted

- **WHEN** every fetch attempt fails with the ref-lock contention signature
- **THEN** `createWorktree` SHALL throw an error containing the final stderr after the bounded attempts

### Requirement: Batch queue dispatch inherits the fetch serialization guarantee

Runs started by `pipeline queue` batch dispatch SHALL obtain their worktree through the same `createWorktree` code path as single-issue runs, so the base-branch fetch serialization and ref-lock retry SHALL apply to queued runs without any queue-specific fetch handling. There SHALL be no separate fetch of the base branch in the queue dispatch path that bypasses the per-repo mutex.

#### Scenario: concurrent queued runs do not block on fetch contention

- **WHEN** `pipeline queue` dispatches multiple runs concurrently against the same repo
- **THEN** each run's base-branch fetch SHALL be serialized under the shared per-repo mutex and retried on ref-lock contention
- **AND** no queued run SHALL be blocked at planning by a `cannot lock ref 'refs/remotes/origin/<base>'` failure caused by a sibling queued run

