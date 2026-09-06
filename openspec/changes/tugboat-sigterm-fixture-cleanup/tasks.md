## 1. Bite the old cleanup race

- [ ] 1.1 Add a helper-level test in `core/test/tugboat.test.ts` that starts a writer under a temp tree, waits for a writer-ready handshake file, then runs a bounded contention loop of naive `fs.rmSync(dir, { recursive: true, force: true })` until it throws `ENOTEMPTY` (or equivalent still-mutating unlink). If the 1,000 ms bite deadline expires without that throw, fail with writer pid, live/zombie/gone, cmdline, and tree listing. Verify the test fails if the writer is not mutating the tree (bite is load-bearing).
- [ ] 1.2 In that same test, after the naive-delete bite, `await` the shared lifecycle cleanup seam and assert the writer is gone or zombie and the temp tree is gone. Verify this step fails while the seam is still kill-then-immediate-`rmSync`.
- [ ] 1.3 Add a static assertion that the SIGTERM wait-for-live fixture name remains in `tugboat.test.ts` and is not wrapped in `test.skip` / flaky markers (same shape as `detach race fixture stays enabled`). Verify the assertion fails if that test is skipped or deleted.

## 2. Extend `reapDetachFixture` into the shared async seam

- [ ] 2.1 Change `reapDetachFixture` to `async function reapDetachFixture(...): Promise<void>` in the same file. After ownership kills it `await waitUntil` until cmdline needles for `dir` and `--milestone v${version}` (and argv-verified `playbook.pid` when present) have no live non-zombie pids. Deadline is 2,000 ms. Poll interval is `waitUntil`'s existing 15 ms (min = max = 15 ms). Verify task 1.2 can wait on a live writer instead of racing `rmSync`.
- [ ] 2.2 Accept optional Node `ChildProcess` handles and close/destroy their stdout and stderr writers and `data` watchers before delete. Missing/undefined handles are no-ops. Verify the SIGTERM fixture can pass its `spawn`ed child when defined, and that cleanup does not throw if the test failed before `spawn`.
- [ ] 2.3 After observed death, delete `dir` inside the seam. On `ENOTEMPTY`/`EBUSY` before the deadline, reap again and retry. At deadline with remaining live owned pids or a still-throwing delete, throw naming remaining pids with ownership source and argv. Verify a catch-and-ignore of `ENOTEMPTY` is not present. Verify no caller keeps `reapDetachFixture(...); fs.rmSync(...)`.
- [ ] 2.4 Keep ownership needles (`dir` cmdline, `--milestone v${version}`). Signal `playbook.pid` only after current `/proc/<pid>/cmdline` contains `dir` or the unique milestone coordinate. Treat `/proc/<pid>/stat` state `Z` as not mutating; do not use `kill(pid, 0)` as the live test. Verify no host-wide or PPID-of-test-worker kill is added, and that an unrelated reused pid is not signaled.

## 3. Switch lifecycle fixtures onto the seam

- [ ] 3.1 Point the SIGTERM wait-for-live fixture `finally` at `await reapDetachFixture(...)` (pass the spawned child handle when defined). Remove the trailing `fs.rmSync`. Verify product assertions still pass: fail closed, no `detached tugboat ship`, unconfirmed child `ESRCH`, later detach admits exactly one live ship, and cleanup does not throw `ENOTEMPTY`.
- [ ] 3.2 Point the other six `reapDetachFixture` callers at the same awaited seam (concurrent detach, wait-for-live expiry, re-parent reap, failed wait-for-live, sequential detach, stale-admission). Convert the three currently sync tests to `async`. Verify each `finally` no longer does kill-then-immediate-`fs.rmSync`.
- [ ] 3.3 Leave static extract/source tests that never spawn a long-lived child on their existing `fs.rmSync`. Verify those tests still pass and were not rewritten onto the seam.

## 4. Gates and evidence

- [ ] 4.1 Run `openspec validate tugboat-sigterm-fixture-cleanup` and verify it passes.
- [ ] 4.2 From `core/`, run `node --test --experimental-strip-types test/tugboat.test.ts` and verify the new bite, the SIGTERM fixture, and sibling lifecycle fixtures pass.
- [ ] 4.3 After the `core/test/tugboat.test.ts` edit, run `node scripts/build.mjs` from the repo root and verify `--check` is clean. This is required after any `core/` change, including test-only files.
- [ ] 4.4 Run `npm run ci` from the repo root and verify it passes.
