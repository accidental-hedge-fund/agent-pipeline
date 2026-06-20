## 1. Fix `maybeArchiveOpenspec` to check commit exit code

- [ ] 1.1 In `core/scripts/stages/pre_merge.ts`, capture the return value of the `git commit` call (currently discarded via `ignoreFailure: true`).
- [ ] 1.2 After the commit call, check whether `commit.code !== 0`; if so, call `setBlockedFn` with the commit stderr and return `{ advanced: false, status: "blocked", reason: "archive commit failed" }`.
- [ ] 1.3 Confirm the `git push` call is only reached when the commit succeeded (exit code 0).

## 2. Regression test

- [ ] 2.1 Add a test case in `core/test/pre-merge.test.ts` (or the file covering `maybeArchiveOpenspec`) where `openspecArchive` resolves successfully, `git status` returns a non-empty diff, and the `git commit` fake returns exit code 1 with a stderr message.
- [ ] 2.2 Assert the test case returns `{ status: "blocked" }` and that `setBlocked` was called with a reason including the commit stderr.
- [ ] 2.3 Assert no `git push` was invoked in the failing-commit path.
- [ ] 2.4 Prove the test bites: confirm it fails on the unmodified code before the fix is applied.

## 3. Mirror + CI

- [ ] 3.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/` and commit the mirror alongside the `core/` change.
- [ ] 3.2 Run `npm run ci` from the repo root; all checks must pass (core tests, mirror in sync, install smoke).
