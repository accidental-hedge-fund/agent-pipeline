## Context

`worktree.ts` exposes two public query functions:

- `listActive(cfg)` — enumerates on-disk worktrees, then calls `getIssueStateAndLabels` for each to filter out closed/terminal ones. Cost: one `gh` call per on-disk worktree.
- `getForIssue(cfg, N)` — calls `listActive()` and returns the first record matching issue N. It inherits the full per-worktree cost even though active-state filtering is irrelevant for a known-issue lookup.

`pipeline.ts` calls `getForIssue()` in at least four places (run setup, pre-stage bookmark, post-fix verify, finalization). With 20 on-disk worktrees this produces 80+ unnecessary `gh` calls per pipeline run that touch no capacity decision.

The existing `GhMetricsCollector` (PR #257) captures per-run call count and latency, making it straightforward to quantify the improvement.

## Goals / Non-Goals

**Goals:**
- Eliminate `gh` calls in `getForIssue()` callers that do not need active-state filtering.
- Add a per-run snapshot cache (`RunStateCache`) so issue/PR state fetched during setup is reused across stages rather than re-fetched independently.
- Preserve the active-state filter for `createWorktree()` capacity enforcement and `sweepMergedWorktrees()`.
- Keep the existing `deps`/`Deps` injection pattern so new code is unit-testable without real subprocesses.

**Non-Goals:**
- Cross-run persistence (no disk or DB cache between pipeline invocations).
- Changing the shape of the `--status --json` output (that is `machine-readable-status`'s scope).
- Altering the concurrency gate semantics.

## Decisions

### Decision 1: `getOnDiskForIssue()` replaces `getForIssue()` for non-capacity callers

`getOnDiskForIssue(cfg, N)` calls `listOnDisk(cfg)` (already exists, no `gh` calls) and returns the first matching record. `getForIssue()` keeps its existing behavior and callers (capacity + sweep paths); non-capacity callers in `pipeline.ts` are migrated to `getOnDiskForIssue()`.

**Alternative considered**: add an `activeOnly?: boolean` flag to `getForIssue()`. Rejected — a boolean flag with an active-state footgun is worse than two clearly named functions.

### Decision 2: `RunStateCache` scoped to one pipeline dispatch cycle

A `RunStateCache` object is created at the top of the pipeline dispatch loop and threaded through stage functions via the existing `deps` pattern (added to the relevant `Deps` interface). It holds: issue state + labels, PR state, and worktree path — populated at named refresh points. Getters throw if accessed before the first `refresh()` so callers cannot silently read stale data.

Named refresh points (called explicitly, not automatically):
- `refreshAfterSetup()` — after worktree creation and initial label apply.
- `refreshAfterFix()` — after a fix commit lands (PR SHA and labels may have changed).

**Alternative considered**: Automatic cache invalidation on label change. Rejected — the pipeline's own commits already required a careful exclusion in the SHA gate (`isPipelineInternalCommit`); adding another implicit invalidation surface risks the same convergence bugs.

### Decision 3: No cache for `listActive()` / `countActive()`

`createWorktree()` must see real-time active state; a stale count could allow exceeding `max_concurrent_worktrees`. These callers are left unchanged and always hit GitHub.

### Decision 4: Benchmark is part of the acceptance gate

The issue specifies wall time and `gh` call count at 0/5/20 worktrees. The benchmark is a manual step in the validation checklist (not a CI gate) since synthetic worktree count requires test fixtures not worth automating for a one-time baseline.

## Risks / Trade-offs

- **Stale worktree path after rename** → `getOnDiskForIssue()` reads the current on-disk slug; a branch rename would still return a stale path if the directory was not recreated. Mitigation: the same risk exists today in `getForIssue()` (it also scans on-disk slugs). No regression.
- **Cache accessed before refresh** → Mitigated by throwing on uninitialized access (Decision 2). Makes the bug loud, not silent.
- **RunStateCache adds coupling** → Threaded via `deps` like existing injected fakes; new stage tests inject a pre-populated fake cache the same way they inject `gh` fakes today.

## Open Questions

None — the scope is narrow and the existing `deps` pattern fully covers testability.
