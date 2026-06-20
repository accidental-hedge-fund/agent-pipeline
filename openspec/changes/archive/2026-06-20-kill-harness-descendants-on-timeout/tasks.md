## 1. Enable process-group kill in `invoke()`

- [ ] 1.1 In `core/scripts/harness.ts`, change the `invoke()` → `runCapped(...)` call to pass `{ killProcessGroup: true }` as the final opts argument for all three harness paths (`claude`, `codex`, custom).

## 2. Regression test — grandchild termination

- [ ] 2.1 Add a test in `core/test/harness.test.ts` that calls `runCapped` directly with a short timeout (≤ 0.5 s) and a command that forks a sleeping grandchild (e.g., `sh -c 'sleep 9999 & wait'`).
- [ ] 2.2 Capture the grandchild PID (written to stdout by the script before sleeping).
- [ ] 2.3 After `runCapped` resolves, assert `result.timed_out === true`.
- [ ] 2.4 Assert that `process.kill(grandchildPid, 0)` throws with `code === 'ESRCH'` (process no longer exists).
- [ ] 2.5 Prove the test bites: run it against the unpatched `invoke()` (or `runCapped` without `killProcessGroup`) and confirm it fails before the fix lands.

## 3. Mirror + CI

- [ ] 3.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror.
- [ ] 3.2 Run `npm run ci` from the repo root and confirm it passes (core tests green, mirror in sync, install smoke passes).
