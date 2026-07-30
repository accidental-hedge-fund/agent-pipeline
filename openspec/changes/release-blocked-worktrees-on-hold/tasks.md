## 1. Capacity identity and blocker kind

- [ ] 1.1 Add a machine-distinguishable capacity error identity from `createWorktree` (stable prefix/type) distinct from dirty-reclaim and generic git failures
- [ ] 1.2 Extend `BlockerKind` + `BLOCKER_RECIPES` with a capacity ops kind (not `needs-human`); update recipe snapshot/string tests
- [ ] 1.3 Wire planning/bootstrap create failure path so pure capacity uses the capacity kind and ops recipe text

## 2. Park-release helper

- [ ] 2.1 Implement `releaseWorktreeForParkedIssue` (or equivalent) reusing dirty/local-only safety ladder and managed-root skip; remote branch/PR never deleted
- [ ] 2.2 Enforce release preconditions: clean, no local-only, remote tip **or** open PR; retain with visible reason otherwise
- [ ] 2.3 Make release idempotent when no managed worktree is on disk
- [ ] 2.4 Inject I/O via deps seams for unit tests (no real network/git/subprocess)

## 3. Invoke release on durable park

- [ ] 3.1 Map durable park outcomes (needs-human hold, non-immediately-recoverable blocked, etc.) and call release once post-harness at the durable outcome sink
- [ ] 3.2 Ensure mid-stage / transient in-process waits do not release
- [ ] 3.3 Confirm resume/re-advance recreates via existing `createWorktree` bootstrap; same-issue reclaim and self-exclusion from capacity remain

## 4. Durable-loop capacity admission

- [ ] 4.1 Route pure capacity outcomes away from product needs-human hold disposition in the supervisor
- [ ] 4.2 When residual true-active capacity is full, stop/hold admission with a clear capacity reason without cascading per-item product capacity blocks
- [ ] 4.3 Preserve genuine product/review needs-human hold behavior unchanged

## 5. Regression tests

- [ ] 5.1 Simulate N parked issues that would retain worktrees; after safe park-release, issue N+1 create succeeds under `max_concurrent_worktrees: N` (test fails without release)
- [ ] 5.2 Dirty / local-only / missing-remote park retains worktree and surfaces reason
- [ ] 5.3 Same-issue reclaim at `max_concurrent_worktrees: 1` still works after the change
- [ ] 5.4 Capacity-only failure is not classified as product needs-human; residual full capacity does not cascade N human product blocks
- [ ] 5.5 Recipe/enum coverage for the capacity kind

## 6. Docs, mirror, CI

- [ ] 6.1 Document capacity count, park-release vs retain, capacity vs product needs-human, and merge-only cleanup limits in operator-facing README/loop docs
- [ ] 6.2 After `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/` with the same change
- [ ] 6.3 `npm run ci` green; `openspec validate release-blocked-worktrees-on-hold` (and `--all` when archiving)
