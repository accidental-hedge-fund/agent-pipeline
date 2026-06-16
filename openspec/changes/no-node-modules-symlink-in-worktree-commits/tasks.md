## 1. Worktree bootstrap — local exclude and symlink removal

- [ ] 1.1 In `core/scripts/worktree.ts`, after `git worktree add` succeeds, write `node_modules` to `.git/info/exclude` inside the new worktree (idempotent: append only if not already present)
- [ ] 1.2 In `core/scripts/worktree.ts`, after writing the exclude, detect a `node_modules` symlink at the worktree root via `fs.lstat`; if it is a symlink, remove it with `fs.unlink` and emit a `[pipeline]` log line
- [ ] 1.3 Add a unit test: bootstrap with a mock worktree root containing a `node_modules` symlink — verify the symlink path is passed to `unlink`, the exclude entry is written, and a non-symlink `node_modules` directory is left untouched

## 2. Salvage path — explicit pathspec exclusion

- [ ] 2.1 In `core/scripts/salvage-harness-work.ts`, change `defaultGitAddAll` from `git add -A` to `git add -A -- :(exclude)node_modules`
- [ ] 2.2 Update the `SalvageDeps.gitAddAll` JSDoc to note the exclusion requirement so injected fakes know to propagate it
- [ ] 2.3 Add a regression test: fake `gitStatus` returns a porcelain line for `node_modules` alongside a real changed file; assert that `gitAddAll` is called with `:(exclude)node_modules` in its arguments and the commit is created

## 3. Post-commit scan in verifyHarnessCommits

- [ ] 3.1 Identify the `verifyHarnessCommits` helper (or its equivalent per-step verification logic in `planning.ts` / `fix.ts`) that inspects the commit range after a harness step
- [ ] 3.2 Add a scan step: for each commit SHA in `headBefore..HEAD`, run `git diff-tree --no-commit-id -r --name-only <sha>` and check whether any output line's first path component equals `node_modules`
- [ ] 3.3 If a `node_modules` entry is found, return `{ status: "blocked", reason: "Commit <sha> adds a node_modules entry (<path>); node_modules must not be committed" }`
- [ ] 3.4 Wire the scan into the implement step, fix-round step, and test-fix step (wherever `verifyHarnessCommits` or its equivalent is already called)
- [ ] 3.5 Add a regression test for the implement step: mock returns a commit that includes `node_modules` in its diff — assert the step returns `blocked` with the expected reason substring
- [ ] 3.6 Add a complementary passing test: mock returns a commit with no `node_modules` entries — assert the step does not block on this check

## 4. Mirror regeneration and CI gate

- [ ] 4.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/` with all changes from steps 1–3
- [ ] 4.2 Run `npm run ci` from the repo root and confirm all checks pass (core tests, mirror sync, install smoke)
- [ ] 4.3 Confirm regression tests introduced in steps 1.3, 2.3, and 3.5–3.6 appear in the test output and would fail without the corresponding fix
