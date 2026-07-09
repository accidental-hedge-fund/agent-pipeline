## 1. Serialize the fetch under the existing per-repo mutex

- [ ] 1.1 In `createWorktree` (`core/scripts/worktree.ts`), move the `resolveGitCommonDir` +
      `worktreeMutexPath` resolution and the mutex acquire/poll loop to **before** the
      `git fetch origin <base_branch>` call, so the critical section covers the fetch, the
      pre-add `branch -D`, and the `git worktree add` retry loop.
- [ ] 1.2 Keep the mutex release in the `finally` block that already wraps `git worktree add`,
      widening its `try` to also enclose the fetch, so the mutex is released on every exit path
      (fetch failure, add failure, or success).
- [ ] 1.3 Widen `MUTEX_TIMEOUT_MS` so a live holder that is now mid-fetch-then-add cannot outlast
      a waiter (the git subprocess timeout is 60 s each for fetch and add; size the wait to cover
      both plus margin) and document the new bound in the comment above the poll loop.

## 2. Bounded, ref-lock-scoped retry for the fetch

- [ ] 2.1 Replace the single `ignoreFailure: false` fetch with a bounded retry loop that calls
      the fetch with `ignoreFailure: true`, inspects `code` and `stderr`, and on `code === 0`
      breaks out (mirroring the `git worktree add` loop structure).
- [ ] 2.2 Define the ref-lock contention signature as stderr containing `cannot lock ref` OR
      `unable to update local ref`; only retry when the signature matches.
- [ ] 2.3 On a non-zero exit whose stderr does NOT match the signature, throw immediately with
      `git fetch origin <base> failed: <stderr>` (preserving today's error text/shape for
      auth/network/missing-remote failures).
- [ ] 2.4 Use exponential backoff with randomized jitter between attempts (base ~200 ms, same
      family as the add retry), bounded to a small fixed attempt count; on exhaustion throw with
      the final stderr.

## 3. Injectable seam for tests

- [ ] 3.1 Add an injectable jitter/random source to `CreateWorktreeDeps` (e.g. `jitter?: () =>
      number` returning a 0–1 fraction), defaulting to a real random source; reuse the existing
      injectable `sleep`. Do not call `Math.random` directly in the retry path so tests stay
      deterministic.
- [ ] 3.2 Confirm the existing `gitCmd` seam is sufficient to simulate fetch outcomes (it is —
      the fetch already routes through `gitFn`).

## 4. Regression + unit tests (`core/test/worktree.test.ts`)

- [ ] 4.1 Regression test: `gitCmd` fake returns a ref-lock failure (`cannot lock ref ...
      unable to update local ref`) for the first `fetch` invocation and success for the second;
      assert `createWorktree` returns normally (no throw), the fetch was retried, and `sleep`
      was the injected fake (no real timer). Prove it bites: without the retry the test throws.
- [ ] 4.2 Non-contention test: `gitCmd` fake returns a non-zero `fetch` with unrelated stderr
      (e.g. `could not read Username` / `Could not resolve host`); assert `createWorktree` throws
      immediately with the underlying stderr and does NOT retry the fetch.
- [ ] 4.3 Serialization test: assert the mutex is acquired before the first `fetch` call and
      released after `git worktree add`, including on the fetch-failure path (mutex not leaked).
- [ ] 4.4 Exhaustion test: `gitCmd` fake returns the ref-lock failure on every fetch attempt;
      assert `createWorktree` throws with the final stderr after the bounded attempts.

## 5. Mirror + gate

- [ ] 5.1 Regenerate the plugin mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [ ] 5.2 `npm run ci` green from repo root (core tests, mirror check, install smoke, openspec validate).
- [ ] 5.3 `openspec validate serialize-base-branch-fetch` passes with no structural errors.
