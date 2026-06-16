## Why

When a harness runs inside a worktree that lacks its own `node_modules` (a common state before #174's dependency-install landed), it may symlink `node_modules → <primary-checkout>/node_modules` to satisfy binary lookups, then commit the symlink via `git add -A`. A repo `.gitignore` of `node_modules/` (trailing slash) suppresses a *directory* but not a *symlink*, so the symlink reaches the branch. On CI the symlink target is absent, causing `pnpm install` to fail with `ENOTDIR` and blocking every subsequent build and test step.

## What Changes

- Before any harness is invoked on a worktree, the pipeline SHALL write `node_modules` (and the common `node_modules` symlink variant `node_modules@*`) to `.git/info/exclude` inside that worktree, so `git add -A` — whether run by the harness or by the salvage path — never stages a `node_modules` entry regardless of whether it is a directory, symlink, or any other filesystem type.
- After a harness step completes and commits are present in the range, `verifyHarnessCommits` SHALL additionally check that no commit in the range adds a `node_modules` entry (any path whose first component is `node_modules`). A violation blocks the step with a clear diagnostic.
- The salvage path's `git add -A` SHALL exclude `node_modules` entries via an explicit pathspec exclusion (`:(exclude)node_modules`), providing a third layer of defense independent of `.git/info/exclude`.
- The worktree lifecycle setup step SHALL remove an existing `node_modules` symlink (and log the removal) before the first harness runs, eliminating the broken symlink from CI immediately even without a new harness run.

## Capabilities

### New Capabilities

- `worktree-staging-exclusions`: Defines the set of paths the pipeline must prevent from being staged into any pipeline-authored or salvage commit in a worktree. Currently the only member is `node_modules`. Covers the per-worktree `.git/info/exclude` setup, the pre-commit scan in `verifyHarnessCommits`, and the explicit pathspec exclusion in the salvage path.

### Modified Capabilities

- `harness-uncommitted-salvage`: The salvage `git add -A` step SHALL use `git add -A -- :(exclude)node_modules` (or equivalent) to ensure `node_modules` is excluded even if `.git/info/exclude` is absent or stale.
- `worktree-lifecycle`: The worktree bootstrap step SHALL write the `node_modules` exclusion to `.git/info/exclude` immediately after the worktree directory is created and before any stage or harness runs.

## Impact

- **`core/scripts/worktree.ts`** — bootstrap step writes `.git/info/exclude`; removes existing `node_modules` symlink.
- **`core/scripts/salvage-harness-work.ts`** — `defaultGitAddAll` switches to `git add -A -- :(exclude)node_modules`; injectable `SalvageDeps.gitAddAll` seam already exists, so tests remain unaffected.
- **`core/scripts/stages/planning.ts` / `fix.ts`** — `verifyHarnessCommits` gains a `node_modules` entry scan after commit-range extraction.
- **`core/test/`** — new regression tests: salvage does not stage a symlink-shaped entry, and `verifyHarnessCommits` blocks when a commit adds `node_modules`.
- No external API or config changes; no migration required.

## Acceptance Criteria

- [ ] A `node_modules` symlink placed in the worktree root before a harness run is NOT present in any commit in the post-run range.
- [ ] `git add -A` in the salvage path does not stage `node_modules` (directory or symlink).
- [ ] `verifyHarnessCommits` blocks the step and surfaces a clear diagnostic when any commit in the range adds a path whose first component is `node_modules`.
- [ ] The worktree bootstrap removes a pre-existing `node_modules` symlink and logs its removal.
- [ ] `npm run ci` passes (all tests green, mirror in sync).
- [ ] A regression test exists that would have caught this bug: salvage of a dirty worktree containing a `node_modules` symlink produces a commit that does NOT include `node_modules`.
