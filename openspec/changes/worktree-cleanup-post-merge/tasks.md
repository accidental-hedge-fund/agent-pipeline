## 1. PR Merge-State Helper

- [ ] 1.1 Add `getPrMergeState(cfg, issueNumber, slug)` to `core/scripts/gh.ts` that calls `gh pr list --state merged --head pipeline/<N>-<slug> --json number,mergedAt -R <repo>` and returns `{ merged: true, prNumber: number } | { merged: false }`
- [ ] 1.2 Add unit test in `core/test/gh.test.ts` (or new test file) covering: merged PR found → `{ merged: true }`, no merged PR → `{ merged: false }`

## 2. Dirty-Worktree Detection

- [ ] 2.1 Add `hasDirtyWorkdir(worktreePath: string)` to `core/scripts/worktree.ts` that runs `git status --porcelain` in the given path and returns `true` if output is non-empty
- [ ] 2.2 Add unit test covering: empty `git status` output → `false`, non-empty → `true`

## 3. Sweep Function

- [ ] 3.1 Add `sweepMergedWorktrees(cfg: PipelineConfig)` to `core/scripts/worktree.ts`; use `listOnDisk` to enumerate pipeline-managed worktrees
- [ ] 3.2 For each worktree: call `getPrMergeState`; if not merged skip silently; if merged check `hasDirtyWorkdir`
- [ ] 3.3 If dirty: add to skipped list with reason `"uncommitted changes"`; if clean: call existing `removeWorktree` and add to removed list
- [ ] 3.4 Return `{ removed: WorktreeRecord[], skipped: Array<{ rec: WorktreeRecord, reason: string }> }`

## 4. Unit Tests for Sweep

- [ ] 4.1 Test: merged PR + clean worktree → worktree appears in `removed`, `removeWorktree` called
- [ ] 4.2 Test: open PR → worktree not in `removed` or `skipped`
- [ ] 4.3 Test: merged PR + dirty worktree → worktree appears in `skipped` with reason `"uncommitted changes"`
- [ ] 4.4 Test: no pipeline worktrees on disk → returns `{ removed: [], skipped: [] }` (idempotent no-op)
- [ ] 4.5 Test: non-pipeline worktree present → not evaluated, not in removed or skipped

## 5. Pipeline Entry Point

- [ ] 5.1 Add `--cleanup` flag (no issue number required) to `core/scripts/pipeline.ts`; route to `sweepMergedWorktrees` before the existing `main()` dispatch
- [ ] 5.2 Print report: removed branch names, skipped branch names with reasons; print "Nothing to clean up." when both lists are empty
- [ ] 5.3 Exit zero regardless of whether any worktrees were removed

## 6. Integration Verification

- [ ] 6.1 Run `pnpm test` (or `cd core && npm test`) — all tests pass
- [ ] 6.2 Manual smoke-check: create a stub worktree with a merged-PR branch name, run `pipeline --cleanup`, confirm removal and output
