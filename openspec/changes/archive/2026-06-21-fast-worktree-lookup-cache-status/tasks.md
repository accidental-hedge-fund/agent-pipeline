## 1. Add `getOnDiskForIssue` to worktree.ts

- [x] 1.1 Confirm `listOnDisk()` performs no GitHub calls
- [x] 1.2 Implement `getOnDiskForIssue(cfg, issueNumber)` using `listOnDisk()`
- [x] 1.3 Export `getOnDiskForIssue` from `worktree.ts`

## 2. Unit-test `getOnDiskForIssue`

- [x] 2.1 Create `core/test/worktree-fast-lookup.test.ts`
- [x] 2.2 Cover found, not-found, and multiple-worktree cases with fake `listOnDisk`
- [x] 2.3 Cover that only the injected disk-listing seam is called

## 3. Migrate known-issue path lookups

- [x] 3.1 Update `pipeline.ts` status JSON and run bookkeeping path lookups
- [x] 3.2 Update stage defaults for path-only worktree lookup
- [x] 3.3 Preserve active filtering for capacity enforcement
- [x] 3.4 Exclude per-run snapshot caching from this change

## 4. Verify

- [x] 4.1 Run `openspec validate fast-worktree-lookup-cache-status`
- [x] 4.2 Run `node scripts/build.mjs` and `node scripts/build.mjs --check`
- [x] 4.3 Run `npm run ci`
