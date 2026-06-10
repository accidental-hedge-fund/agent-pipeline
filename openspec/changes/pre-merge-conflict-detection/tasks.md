## 1. Early Conflict Detection in pre_merge.ts

- [ ] 1.1 In `advance()`, fetch `getPrDetail` once before Step 1 (CI poll) and store in a local `prDetail` variable; thread it through to the existing mergeability check in Step 2 to eliminate the second `getPrDetail` call.
- [ ] 1.2 After fetching `prDetail`, call `parseMergeable(prDetail)` and if the result is `"conflict"`, enter the early-conflict branch: check `rebaseAlreadyAttempted`; if already attempted, call `setBlockedFn` with "merge conflict — manual rebase needed" and return `blocked`; otherwise call `tryRebaseAndPush`, mark as attempted, and return `waiting: "rebase-resolved; CI re-running"`.
- [ ] 1.3 Apply `rebaseAlreadyAttempted` guard to the existing mergeability conflict path in Step 2 (it currently lacks the guard, risking a rebase loop if the early check somehow misses the conflict on the first call).

## 2. Regression Test

- [ ] 2.1 Create `core/test/pre-merge-conflict-detection.test.ts` with a fixture that injects `getPrDetail` returning `mergeable: false` (CONFLICTING) and `getPrChecks` that should **not** be called (assert it is never invoked); confirm the outcome is `status: "waiting"` with rebase attempted.
- [ ] 2.2 Add a second fixture with `rebaseAlreadyAttempted` already set (marker file exists): confirm the outcome is `status: "blocked"` with a reason containing "merge conflict".
- [ ] 2.3 Add a fixture for `mergeable: null` (UNKNOWN): confirm the gate does NOT enter the early-conflict path and proceeds to the CI poll.
- [ ] 2.4 Prove the tests bite by temporarily removing the early-conflict branch from `advance()` and confirming the tests fail; restore afterwards.

## 3. CI Gate

- [ ] 3.1 Run `npm run ci` from the repo root; confirm all tests pass and the plugin mirror is in sync (`build.mjs --check`).
