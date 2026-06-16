## 1. Per-repo worktree-creation mutex

- [ ] 1.1 Add `repoHash(repoDir: string): string` helper (8-hex-char SHA-1 prefix of the repo path) and `worktreeMutexPath(cfg)` → `/tmp/pipeline-wt-<hash>.lock` to `worktree.ts`.
- [ ] 1.2 Implement `acquireWorktreeMutex(mutexPath, deps)` with stale-PID recovery matching the domain lock pattern; write current PID on acquire.
- [ ] 1.3 Implement `releaseWorktreeMutex(mutexPath, deps)` that removes the lock file.
- [ ] 1.4 Extend `CreateWorktreeDeps` with injectable `acquireMutex`, `releaseMutex`, and `sleep` hooks so tests bypass real I/O and timers.

## 2. Retry loop on .git/config.lock contention

- [ ] 2.1 Wrap the `git worktree add` call in a retry loop (max 3 attempts, 200/400/800 ms exponential back-off via injected `sleep`).
- [ ] 2.2 Gate retries on `stderr.includes("could not lock config file")` — non-lock failures throw immediately without retrying.
- [ ] 2.3 On retry exhaustion, throw with the final stderr (same message format as before).

## 3. Wire mutex into createWorktree

- [ ] 3.1 Acquire the mutex before `git worktree add`, release it (in a try/finally) immediately after the subprocess returns, whether or not the call succeeded.

## 4. Update worktree-creation-failed recovery recipe

- [ ] 4.1 Update the `worktree-creation-failed` entry in `BLOCKER_RECIPES` (`core/scripts/types.ts`) to include: `rm -f .git/config.lock`, `git branch -D pipeline/<N>-<slug>`, remove `blocked` label, re-run.

## 5. Tests

- [ ] 5.1 `acquireWorktreeMutex`: stale file (dead PID) → reclaimed and acquired; live PID → throws; clean path → acquired.
- [ ] 5.2 `createWorktree` retry logic: first call returns `.git/config.lock` error, second succeeds → returns normally; all 3 fail → throws with final stderr; non-lock error on first call → throws immediately (no retry).
- [ ] 5.3 `createWorktree` mutex wiring: mutex acquired before `gitCmd`, released after even when `gitCmd` throws.
- [ ] 5.4 Snapshot/string assertion for `worktree-creation-failed` recipe text covering the four cleanup steps.

## 6. Mirror + CI

- [ ] 6.1 `node scripts/build.mjs` regenerates `plugin/`; `npm run ci` passes green.
