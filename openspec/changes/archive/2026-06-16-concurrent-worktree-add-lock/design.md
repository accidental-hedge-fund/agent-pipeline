## Context

`createWorktree` calls `git worktree add -b <branch> <path> origin/<base>`. Git writes the new branch's upstream tracking config to the shared `.git/config`, which requires an exclusive lock on `.git/config.lock`. Two concurrent calls in the same repo race this lock; the loser exits non-zero (`error: could not lock config file .git/config: File exists`). The current error path throws immediately, leaving a dangling branch and a `blocked` issue.

The per-domain PID lock (`/tmp/pipeline-<domain>.lock`) prevents two runs of the _same domain_ from overlapping, but concurrent runs on different `--domain` values share `.git/config` with no coordination.

## Goals / Non-Goals

**Goals:**
- Ensure concurrent `createWorktree` calls in the same repo never fail due to `.git/config.lock` contention.
- Provide a clear, actionable `worktree-creation-failed` recovery recipe for any residual failures.
- Keep the fix self-contained to `worktree.ts` and `types.ts`; no stage logic changes.

**Non-Goals:**
- Eliminating all possible `git worktree add` failure modes (only `.git/config.lock` contention is addressed).
- Changing the per-domain PID lock semantics or scope.
- Cross-machine coordination (single-machine concurrency only).

## Decisions

### Decision 1: Belt-and-suspenders — mutex + retry, not retry alone

**Chosen:** A cross-process per-repo PID mutex (`/tmp/pipeline-wt-<repo-hash>.lock`) serializes `git worktree add` calls, eliminating the race. A bounded retry (3 attempts, exponential backoff starting 200 ms) handles any residual window (e.g., lock acquisition between the stale-check and the create, OS scheduling jitter).

**Alternative considered — retry only (no mutex):** Simpler, but retry under sustained concurrent load can still exhaust before the other instance finishes. A 3-attempt backoff with ~200/400/800 ms delay covers a window of ~1.4 s; if the other `git worktree add` takes longer, the loser still fails. Retry is necessary but not sufficient for a guaranteed fix.

**Alternative considered — mutex only (no retry):** The mutex serializes the call cleanly; retry is theoretically redundant. But a very brief lock-release/re-acquire window can still race on slower filesystems, and retry is cheap. Belt-and-suspenders.

### Decision 2: Repo hash as mutex namespace, not domain

The contention is in the shared `.git/config`, which is per-repo, not per-domain. A mutex keyed by domain would not prevent cross-domain contention. The mutex is keyed on a short hash of `cfg.repo_dir` so it is repo-scoped.

**Lock path:** `/tmp/pipeline-wt-<8-hex-chars-of-sha1(repo_dir)>.lock`

### Decision 3: Stale PID recovery mirrors the domain lock

The mutex file holds the current PID. On acquisition: if the file exists, read PID, probe with `process.kill(pid, 0)` — dead or invalid PID → remove and re-acquire. This is the same pattern already used for the domain lock; re-using it keeps the codebase consistent.

**Lock hold time:** Only during the `git worktree add` subprocess call (typically < 2 s). Never held across stage execution.

### Decision 4: Retry only on `.git/config.lock` fingerprint

Retry is gated on the presence of `.git/config.lock` (or the string `"could not lock config file"`) in stderr. Unrelated `git worktree add` failures (e.g., path already exists, branch name collision) throw immediately — no spurious retries on unfixable errors.

## Risks / Trade-offs

- **Lock file orphan on SIGKILL:** A hard kill between `git worktree add` completing and the lock release leaves a stale lock. The PID probe on next acquisition recovers it. Risk: if the PID is reused by a long-lived process before recovery, the next run may wait one retry interval unnecessarily. Acceptable; the lock hold time is short.
- **Cross-machine concurrency:** The file lock is local (`/tmp`). Multiple machines writing to the same repo (shared NFS, mounted volume) are not protected. This is out of scope — pipeline runs are single-machine.
- **Exponential backoff ceiling:** 3 retries with 200/400/800 ms delays totals ~1.4 s of wait time in the worst case. If the concurrent `git worktree add` is slower than this (e.g., large repo, slow disk), the retry loop exhausts and falls back to `worktree-creation-failed`. The mutex makes this path reachable only if the mutex implementation itself has a bug; in practice the mutex prevents the race entirely.

## Migration Plan

No migration needed. The change is purely additive to `createWorktree` internal behavior; callers and the `Deps` interface gain optional injectable fakes for the mutex operations, consistent with existing test patterns.
