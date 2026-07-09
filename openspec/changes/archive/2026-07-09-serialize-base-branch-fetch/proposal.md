## Why

Launching multiple detached runs in the same repo within a second of each other can
block one of them at planning with a git ref-lock error. `createWorktree`
(`core/scripts/worktree.ts`) fetches `origin/<base_branch>` before creating the
worktree, and that fetch runs **outside** the per-repo mutex that already serializes
`git worktree add` (added in v1.2.2, #183). When two runs' fetches overlap and one
updates `refs/remotes/origin/<base>` while the other is mid-fetch, the loser fails with:

```
error: cannot lock ref 'refs/remotes/origin/main': is at <new> but expected <old>
 ! <old>..<new>  main -> origin/main  (unable to update local ref)
```

Because the fetch uses `ignoreFailure: false`, this wrapped error propagates and blocks
the run at planning. Evidence: 2026-07-07, engine v1.14.1, runs for #398/#391/#390
launched within ~1s; #398 blocked in 12s on exactly this ref-lock; a manual `git fetch`
+ relaunch recovered it cleanly. The sibling operation (`git worktree add`) was already
hardened against `.git/config.lock` contention with a mutex + retry; the fetch path needs
the same treatment.

## What Changes

- Move the per-repo worktree mutex acquisition to **before** the base-branch fetch so the
  critical section covers the fetch, the stale-branch cleanup, and `git worktree add` — the
  three common-dir-mutating git operations in `createWorktree`. This deterministically
  serializes concurrent fetches of the same repo (two runs from different linked worktrees
  share the same mutex, keyed on the canonical Git common directory).
- Add a bounded retry with exponential backoff **plus randomized jitter** around the fetch,
  scoped to the ref-lock contention signature (`cannot lock ref` / `unable to update local
  ref`). This is belt-and-suspenders against a ref lock left by an external or crashed git
  process the mutex cannot see — mirroring the existing config-lock retry on `git worktree add`.
- A fetch that fails for any **non-contention** reason (auth, network, missing remote) SHALL
  still throw immediately with the underlying stderr — the retry is scoped strictly to the
  ref-lock signature, never a catch-all.
- Extend the mutex wait timeout so a live holder that is now mid-fetch-then-add cannot outlast
  the wait (the critical section is longer than add-only).
- Make the fetch retry's sleep and jitter source injectable via the existing
  `CreateWorktreeDeps` seam so unit tests simulate contention and retry sequencing with no real
  network, git, or timers.

`pipeline queue` batch dispatch inherits this guarantee automatically: every queued run reaches
`createWorktree` through the same detached-launch path, so there is no separate fetch to harden.

## Capabilities

### Modified Capabilities
- `worktree-creation-concurrency`: The per-repo mutex critical section is extended to cover the
  base-branch fetch (not just `git worktree add`); a ref-lock-scoped bounded retry with jitter is
  added for the fetch; and the injectable-deps requirement is extended to the fetch retry's
  sleep/jitter seam.

## Impact

- `core/scripts/worktree.ts` — `createWorktree`: relocate mutex acquisition before the fetch;
  wrap the fetch in a ref-lock-scoped retry loop (call with `ignoreFailure: true`, inspect
  stderr); widen `MUTEX_TIMEOUT_MS` to cover fetch + add; add fetch-retry sleep/jitter deps.
- `core/scripts/worktree.ts` — `CreateWorktreeDeps`: add an injectable jitter/random source
  (sleep is already injectable).
- `core/test/worktree.test.ts` — regression test: injected git seam returns a ref-lock failure
  on the first fetch and success on the second; assert `createWorktree` proceeds (no throw) and
  did not sleep for real. Non-contention fetch failure test asserts an immediate throw.
- `plugin/` mirror — regenerated after the `core/` change (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] Two runs fetching the same repo concurrently both proceed: the base-branch fetch is
      serialized under the shared per-repo mutex (the same mutex that guards `git worktree add`),
      and additionally retried (bounded, with jitter) on ref-lock contention.
- [ ] A fetch that fails for a non-contention reason (auth, network, missing remote) still blocks
      with the underlying error — the retry is scoped to the ref-lock signature (`cannot lock ref`
      / `unable to update local ref`), never a generic non-zero exit.
- [ ] A regression test simulates the ref-lock failure via the injected git seam and asserts the
      run proceeds after the retry rather than blocking, using no real network, git, or timers.
- [ ] The mutex is released after `git worktree add` completes (success or failure), exactly as
      before — the extended critical section does not leak the mutex on the fetch-failure path.
- [ ] `pipeline queue` batch dispatch is covered by the same guarantee because every queued run
      creates its worktree through the same `createWorktree` fetch path (no separate fetch to fix).
