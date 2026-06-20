## Why

`getForIssue()` calls `listActive()`, which issues one `gh` API call per on-disk worktree to decide whether each is still active — even when the caller only needs a path for a *known* issue. `pipeline.ts` calls `getForIssue()` up to four times per run (setup, per-stage bookkeeping, and finalization), making the per-run `gh` call count grow linearly with worktree count even though no capacity decision is being made.

## What Changes

- Add `getOnDiskForIssue()`: a fast path that resolves a worktree path by scanning on-disk records only, skipping all GitHub calls. Use it for the four `getForIssue()` call sites in `pipeline.ts` that do not need active-state filtering.
- Reserve `listActive()` and `countActive()` for the two callers that genuinely need active-state data: `createWorktree()` capacity enforcement and `sweepMergedWorktrees()`.
- Add a per-run issue/PR/worktree snapshot cache (`RunStateCache`) with explicit, named refresh points. Callers share one GitHub fetch per refresh point rather than each issuing independent calls.
- Benchmark `pipeline N --status --json` wall time and `gh` call count at 0, 5, and 20 worktrees before and after.

## Capabilities

### New Capabilities

- `worktree-fast-lookup`: Fast on-disk worktree resolution for known-issue callers, plus a run-scoped snapshot cache that batches GitHub reads at named refresh points.

### Modified Capabilities

- `worktree-lifecycle`: The concurrency gate (`createWorktree`) continues to use `listActive()`; all other callers that do not need active-state filtering MUST use `getOnDiskForIssue()` instead of `getForIssue()`.

## Impact

- `core/scripts/worktree.ts`: add `getOnDiskForIssue()`, keep `listActive()`/`getForIssue()` for their existing callers.
- `core/scripts/pipeline.ts`: replace four `getForIssue()` call sites with `getOnDiskForIssue()` (or the cache accessor when the snapshot is already warm).
- New `core/scripts/run-state-cache.ts`: `RunStateCache` class with `refresh()` and typed getters.
- `core/test/`: new test files for `getOnDiskForIssue()` and `RunStateCache`.
- No CLI-visible behavior change; `--status --json` latency and `gh` call count decrease.

## Acceptance Criteria

- [ ] `getOnDiskForIssue(cfg, N)` returns the worktree path/slug for issue N by reading on-disk records only — zero GitHub calls.
- [ ] `pipeline.ts` call sites for setup, per-stage bookkeeping, and finalization use `getOnDiskForIssue()` (or the run cache) instead of `getForIssue()`.
- [ ] `listActive()` is still called by `createWorktree()` capacity enforcement; the concurrency gate is not weakened.
- [ ] A `RunStateCache` exists with at least one named refresh point and typed accessors; callers that previously issued independent GitHub reads share the cached values.
- [ ] `pipeline N --status --json` with 20 on-disk worktrees makes fewer `gh` calls than before (verified by the `GhMetricsCollector` count in the run event or by the benchmark).
- [ ] All existing tests pass; new unit tests cover `getOnDiskForIssue()` (with fake on-disk records, no real git/network) and `RunStateCache` (inject/refresh/access cycle).
