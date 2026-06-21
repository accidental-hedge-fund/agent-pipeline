## Context

`worktree.ts` exposes two different worktree query needs:

- `listActive(cfg)` enumerates on-disk worktrees, then calls `getIssueStateAndLabels` for each worktree to filter out closed or terminal issues. This is required for capacity decisions, but it costs one GitHub call per on-disk worktree.
- `getForIssue(cfg, N)` calls `listActive()` and inherits that cost even when the caller only needs the local path for a known issue.

Pipeline setup, bookkeeping, status JSON, and stage handlers often need only the local path for the issue already being processed. They do not need active-state filtering and should not pay the per-worktree GitHub fan-out.

## Goals / Non-Goals

**Goals:**
- Add a disk-only lookup for known issue worktree paths.
- Move non-capacity known-issue path lookups to the disk-only lookup.
- Preserve active-state filtering for capacity enforcement.
- Keep the existing `deps`/`Deps` injection pattern so tests avoid real subprocesses and network calls.

**Non-Goals:**
- Adding a per-run issue/PR snapshot cache.
- Cross-run persistence or disk/database caching.
- Changing `--status --json` output shape.
- Changing concurrency gate semantics.

## Decisions

### Decision 1: `getOnDiskForIssue()` is a separate explicit fast path

`getOnDiskForIssue(cfg, N)` calls `listOnDisk(cfg)` and returns the first record matching the requested issue. It does not call GitHub and returns `null` when no on-disk record exists.

**Alternative considered**: add an `activeOnly?: boolean` flag to `getForIssue()`. Rejected because a boolean flag would make the active-state cost easy to trigger accidentally. Two named functions keep the behavior clear.

### Decision 2: Keep active-state filtering only where it is needed

`createWorktree()` must continue to use active-state filtering through `listActive()` / `countActive()` so the concurrency gate excludes closed and terminal worktrees while failing safe on GitHub lookup errors.

Known-issue callers that only need a path use `getOnDiskForIssue()` directly or keep their existing injectable `getForIssue` test seam while defaulting that seam to `getOnDiskForIssue()`.

### Decision 3: Benchmark remains manual evidence, not a new cache design

The issue asks to compare `pipeline N --status --json` with multiple on-disk worktree counts. This change makes the status path use the disk-only lookup by default, so its known-issue worktree lookup no longer scales with unrelated worktree count. A separate cache design can be proposed later if issue/PR snapshot sharing is still worth the coupling.

## Risks / Trade-offs

- **Stale worktree path after rename**: `getOnDiskForIssue()` reads the current on-disk records, matching the existing path-source behavior of `getForIssue()`.
- **Bypassing active filtering where it matters**: capacity enforcement remains on `listActive()` / `countActive()`; tests and source checks cover the known-issue stage defaults.
- **Leaving snapshot caching for later**: this avoids broad dispatch/stage interface changes in a performance PR whose main benefit is eliminating accidental active-worktree fan-out.

## Open Questions

None.
