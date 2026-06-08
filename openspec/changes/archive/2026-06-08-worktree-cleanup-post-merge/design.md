## Context

`core/scripts/worktree.ts` owns the entire worktree lifecycle. It already has:
- `listOnDisk(cfg)` — returns every on-disk pipeline-managed worktree (all issues, all states).
- `removeWorktree(cfg, issueNumber, slug)` — removes the worktree directory, deregisters it from git, and deletes the local branch.

`core/scripts/gh.ts` already has:
- `getPrForIssue(cfg, issueNumber)` — returns a PR number if there is an **open** PR for the issue. It only queries `--state open`, so it returns `null` for merged PRs.

The missing piece is (a) a way to find a PR for an issue regardless of state, and (b) detecting uncommitted local changes in a worktree before removal.

## Decision: Where the sweep lives

The sweep (`sweepMergedWorktrees`) lives in `core/scripts/worktree.ts` alongside the existing lifecycle functions. It does not belong in a stage module — it is not issue-specific work but a housekeeping operation over all worktrees.

## Decision: PR merge detection

We need a `getPrMergeState(cfg, issueNumber)` helper (in `gh.ts`) that calls `gh pr list --state merged --head pipeline/<N>-<slug> --json number,mergedAt -R <repo>` and returns `{ merged: true, prNumber: number } | { merged: false }`. Querying by `--head <branch>` is precise — it matches exactly the branch convention used by the pipeline.

Alternative considered: use `getPrForIssue` but drop `--state open`. Rejected — `getPrForIssue` searches by body/title text, not by branch name. Using branch name is more reliable and doesn't risk cross-issue false positives.

## Decision: Dirty-worktree check

Before removing a worktree, run `git status --porcelain` in the worktree directory. Any non-empty output means uncommitted changes are present → skip and report. This mirrors the human `git worktree remove` UX where `--force` is required to discard changes.

## Decision: Entry point

Add `--cleanup` as a flag to `core/scripts/pipeline.ts`. It requires no issue number, runs `sweepMergedWorktrees`, prints the structured report, and exits. This keeps cleanup discoverable as a pipeline subcommand (`pipeline --cleanup`) without adding a new binary or mode string.

Alternative considered: auto-run sweep at the start of every pipeline invocation. Deferred — it adds latency on every run and the open question in the issue is unresolved. The explicit flag approach is the safe, conservative choice that the issue's AC requires; auto-sweep can be layered on top later.

## Decision: Local branch pruning

Remove the local branch when removing the worktree, matching the behavior of the existing `removeWorktree` call. The remote branch is never touched (consistent with the existing contract — the pipeline never force-pushes or deletes remote branches).

## Decision: Reporting format

`sweepMergedWorktrees` returns `{ removed: WorktreeRecord[], skipped: Array<{ rec: WorktreeRecord, reason: string }> }`. The caller (pipeline entry point) formats this into human-readable output. Tests assert on the returned data structure, not stdout.

## Affected Files

| File | Change |
|---|---|
| `core/scripts/worktree.ts` | Add `sweepMergedWorktrees`, `hasDirtyWorkdir` |
| `core/scripts/gh.ts` | Add `getPrMergeState` |
| `core/scripts/pipeline.ts` | Add `--cleanup` flag, route to sweep |
| `core/test/worktree.test.ts` | Unit tests for sweep (new or extended) |
| `core/test/gh.test.ts` | Unit test for `getPrMergeState` (new or extended) |
