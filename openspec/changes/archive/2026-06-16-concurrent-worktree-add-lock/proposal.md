## Why

Launching two `/pipeline N` runs near-simultaneously (distinct `--domain` values, which is the advertised way to run concurrently) can cause one `git worktree add` to fail with `error: could not lock config file .git/config: File exists`. The loser aborts, leaves a dangling `pipeline/N-<slug>` branch, and idles under a `blocked` label — requiring manual cleanup before the run can proceed. The per-domain PID lock intentionally allows concurrent runs, so concurrent worktree creation must also be safe.

## What Changes

- `core/scripts/worktree.ts` (`createWorktree`): on `git worktree add` exit-code != 0 AND `.git/config.lock` in stderr, retry up to **3** times with exponential backoff (starting at ~200 ms), then throw on exhaustion. The existing `ignoreFailure` path is replaced by a retry-aware wrapper that surfaces the final error unchanged.
- `core/scripts/worktree.ts`: introduce a **cross-process per-repo worktree-creation mutex** — a PID lock at `/tmp/pipeline-wt-<repo-hash>.lock` with the same stale-recovery logic as the domain lock — held only for the duration of the `git worktree add` call. This serializes the critical section across concurrent pipeline instances in the same repo.
- `core/scripts/types.ts` (`BLOCKER_RECIPES`): update the `worktree-creation-failed` recipe to include the specific manual recovery steps for a `.git/config.lock` failure (remove lock file, delete dangling branch, remove `blocked` label, re-run).

## Capabilities

### New Capabilities
- `worktree-creation-concurrency`: `createWorktree` is safe under concurrent invocation across pipeline instances in the same repo — transient `.git/config.lock` contention is resolved by a bounded retry loop and a cross-process per-repo mutex, so neither concurrent run is forced to block on a `worktree-creation-failed` due to a timing race.

### Modified Capabilities
- `blocked-recovery-recipes`: The `worktree-creation-failed` recipe text SHALL include the specific `.git/config.lock` cleanup steps (remove lock file, delete dangling branch, remove `blocked` label, re-run).

## Acceptance Criteria

- [ ] Two pipeline runs launched concurrently for different issues in the same repo both reach the planning stage — neither is blocked by `.git/config.lock` contention.
- [ ] When `git worktree add` fails with `.git/config.lock` in stderr, `createWorktree` retries up to 3 times with exponential backoff before throwing.
- [ ] If all retries exhaust, the failure propagates as a `worktree-creation-failed` block with the specific cleanup recipe posted to GitHub.
- [ ] The `worktree-creation-failed` recovery comment includes: `rm -f .git/config.lock`, `git branch -D pipeline/<N>-<slug>`, remove `blocked` label, re-run.
- [ ] The cross-process per-repo mutex lock is stale-recovered (dead PID → reclaim) on acquisition, mirroring the domain lock pattern.
- [ ] Unit tests cover: retry-succeeds-on-second-attempt, retries-exhausted-throws, mutex-stale-recovery.
- [ ] `npm run ci` passes.

## Impact

- `core/scripts/worktree.ts` (primary), `core/scripts/types.ts` (`BLOCKER_RECIPES`), `core/test/worktree.test.ts`.
- No changes to the state-machine edges, review layer, or any other pipeline stage.
- No new external dependencies — only standard Node `fs` + the existing `git` subprocess wrapper.
