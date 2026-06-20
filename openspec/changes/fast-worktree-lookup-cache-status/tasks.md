## 1. Add `getOnDiskForIssue` to worktree.ts

- [ ] 1.1 Read `listOnDisk()` in `core/scripts/worktree.ts` and confirm it performs no GitHub calls
- [ ] 1.2 Implement `getOnDiskForIssue(cfg, issueNumber)` using `listOnDisk()` — returns `{ path, slug } | null`
- [ ] 1.3 Export `getOnDiskForIssue` from `worktree.ts`

## 2. Unit-test `getOnDiskForIssue`

- [ ] 2.1 Create `core/test/worktree-fast-lookup.test.ts`
- [ ] 2.2 Write test: found on disk — fake `listOnDisk` returns a record for the target issue, verify result and zero `gh` calls
- [ ] 2.3 Write test: not on disk — fake `listOnDisk` returns empty, verify `null` returned
- [ ] 2.4 Write test: multiple on-disk worktrees — verify only the correct record is returned
- [ ] 2.5 Prove tests bite (fail without the implementation)

## 3. Implement `RunStateCache`

- [ ] 3.1 Create `core/scripts/run-state-cache.ts` with `RunStateCache` class
- [ ] 3.2 Add typed fields for issue state/labels, PR state, and worktree path
- [ ] 3.3 Implement `refreshAfterSetup(cfg)` — fetches issue state/labels and PR state
- [ ] 3.4 Implement `refreshAfterFix(cfg)` — re-fetches the same data
- [ ] 3.5 Make accessors throw a clear error if called before any `refresh*` has been called
- [ ] 3.6 Add cache to the relevant `Deps` interface(s) in `pipeline.ts` so it can be injected

## 4. Unit-test `RunStateCache`

- [ ] 4.1 Create `core/test/run-state-cache.test.ts`
- [ ] 4.2 Write test: accessor throws before first refresh
- [ ] 4.3 Write test: accessors return values from `refreshAfterSetup`
- [ ] 4.4 Write test: `refreshAfterFix` updates cached values
- [ ] 4.5 Write test: stage function reads from injected fake cache, no real `gh` calls

## 5. Migrate `pipeline.ts` call sites

- [ ] 5.1 Identify the four `getForIssue()` call sites in `pipeline.ts` (run setup ~line 1789, per-stage bookmark ~line 1925, post-fix verify ~line 1971, finalization ~line 2107)
- [ ] 5.2 Replace each with `getOnDiskForIssue()` or the `RunStateCache` accessor where the snapshot is already warm
- [ ] 5.3 Confirm `createWorktree()` and `sweepMergedWorktrees()` still call `listActive()` — do not migrate them

## 6. Verify and benchmark

- [ ] 6.1 Run `npm run ci` from repo root — all tests pass
- [ ] 6.2 Baseline benchmark (before migrating, on a branch with the old code): `pipeline N --status --json` with 0, 5, and 20 fake/real worktrees — record wall time and `gh` call count from the run event
- [ ] 6.3 Post-change benchmark: same setup, confirm `gh` call count is reduced proportional to worktree count
- [ ] 6.4 Confirm `npm run ci` still green after benchmark
- [ ] 6.5 Regenerate `plugin/` mirror: `node scripts/build.mjs` and commit result

## 7. Regenerate plugin mirror and final CI

- [ ] 7.1 Run `node scripts/build.mjs` to regenerate `plugin/`
- [ ] 7.2 Run `node scripts/build.mjs --check` to confirm mirror is in sync
- [ ] 7.3 Run `npm run ci` — full gate passes before marking done
