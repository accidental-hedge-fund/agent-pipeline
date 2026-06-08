## 1. PR Merge-State Helper

- [x] 1.1 Add `getPrMergeState(cfg, branch)` to `core/scripts/gh.ts` — exact `--head` match, returns `{ merged: true, prNumber, headSha } | { merged: false }`; also exports `parsePrMergeState` pure parser
- [x] 1.2 Unit tests in `core/test/gh-parsers.test.ts`: merged PR found → `{ merged: true }`, empty array → `{ merged: false }`

## 2. Dirty-Worktree Detection

- [x] 2.1 Add `hasDirtyWorkdir(worktreePath)` + exported `parseDirtyWorkdir` pure parser to `core/scripts/worktree.ts`
- [x] 2.2 Unit tests: empty output → `false`, non-empty → `true`

## 3. Sweep Function

- [x] 3.1 Add `sweepMergedWorktrees(cfg, deps?)` to `core/scripts/worktree.ts`; filters by `cfg.worktree_root` path AND `pipeline/<N>-<slug>` branch pattern
- [x] 3.2 For each candidate: call `getPrMergeState` by exact branch; skip silently if not merged
- [x] 3.3 If dirty: skipped with `"uncommitted changes"`; if local HEAD diverges from PR headSha: skipped with explanation; if clean: `removeWorktree` + added to removed list
- [x] 3.4 Returns `{ removed: WorktreeRecord[], skipped: Array<{ rec, reason }> }`

## 4. Unit Tests for Sweep

- [x] 4.1 merged PR + clean + same SHA → `removed`, `removeWorktree` called
- [x] 4.2 open PR → not in `removed` or `skipped`
- [x] 4.3 merged PR + dirty → `skipped` with reason `"uncommitted changes"`
- [x] 4.4 merged PR + clean + diverged HEAD → `skipped` with "local HEAD differs" reason
- [x] 4.5 no pipeline worktrees → `{ removed: [], skipped: [] }` (idempotent no-op)
- [x] 4.6 worktree outside `cfg.worktree_root` → ignored
- [x] 4.7 second run is a no-op (idempotent)

## 5. Pipeline Entry Point

- [x] 5.1 `--cleanup` flag added to `core/scripts/pipeline.ts`; `<number>` made optional `[number]`; routes to `runCleanup(cfg)` after config resolution, before kill-switch / issue-number checks
- [x] 5.2 Print report: removed branch names, skipped branch names with reasons; "Nothing to clean up." when both empty
- [x] 5.3 Exits zero

## 6. Integration Verification

- [x] 6.1 `cd core && npm test` — all tests pass (0 failures)
