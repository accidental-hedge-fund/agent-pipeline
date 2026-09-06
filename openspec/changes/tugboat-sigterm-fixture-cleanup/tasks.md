## 1. Bite the old cleanup race

- [ ] 1.1 Add a helper-level test in `core/test/tugboat.test.ts` that starts a writer creating files under a temp tree and asserts naive `fs.rmSync(dir, { recursive: true, force: true })` throws `ENOTEMPTY` (or equivalent still-mutating unlink). Verify the test fails if the writer is not mutating the tree (bite is load-bearing).
- [ ] 1.2 In that same test, after the naive-delete bite, run the shared lifecycle cleanup seam and assert the writer is `ESRCH` and the temp tree is gone. Verify this step fails while the seam is still kill-then-immediate-`rmSync`.
- [ ] 1.3 Add a static assertion that the SIGTERM wait-for-live fixture name remains in `tugboat.test.ts` and is not wrapped in `test.skip` / flaky markers. Verify the assertion fails if that test is skipped or deleted.

## 2. Extend `reapDetachFixture` into the shared seam

- [ ] 2.1 Extend `reapDetachFixture` (same file) so after existing ownership kills it waits until cmdline needles for `dir` and `--milestone v${version}` (and `playbook.pid` when present) are gone. Use a named 2,000 ms deadline and poll at most every 20 ms. Verify task 1.2 can wait on a live writer instead of racing `rmSync`.
- [ ] 2.2 Accept optional Node `ChildProcess` handles and close/destroy their stdout and stderr writers and `data` watchers before delete. Verify the SIGTERM fixture can pass its `spawn`ed child and no pipe remains open across delete.
- [ ] 2.3 After observed death, delete `dir` inside the seam. On `ENOTEMPTY`/`EBUSY` before the deadline, reap again and retry. At deadline with remaining owned pids or a still-throwing delete, throw naming remaining pids. Verify a catch-and-ignore of `ENOTEMPTY` is not present.
- [ ] 2.4 Keep ownership needles unchanged (`dir` cmdline, `--milestone v${version}`, `playbook.pid`). Verify no host-wide or PPID-of-test-worker kill is added.

## 3. Switch lifecycle fixtures onto the seam

- [ ] 3.1 Point the SIGTERM wait-for-live fixture `finally` at the shared seam (pass the spawned child handle). Remove the trailing `fs.rmSync`. Verify product assertions still pass: fail closed, no `detached tugboat ship`, unconfirmed child `ESRCH`, later detach admits exactly one live ship, and cleanup does not throw `ENOTEMPTY`.
- [ ] 3.2 Point the other `reapDetachFixture` callers that still `fs.rmSync` immediately after kill at the same seam (concurrent detach, wait-for-live expiry, re-parent reap, failed wait-for-live, sequential detach, stale-admission). Verify each `finally` no longer does kill-then-immediate-`fs.rmSync`.
- [ ] 3.3 Leave static extract/source tests that never spawn a long-lived child on their existing `fs.rmSync`. Verify those tests still pass and were not rewritten onto the seam.

## 4. Gates and evidence

- [ ] 4.1 Run `openspec validate tugboat-sigterm-fixture-cleanup` and verify it passes.
- [ ] 4.2 From `core/`, run `node --test --experimental-strip-types test/tugboat.test.ts` and verify the new bite, the SIGTERM fixture, and sibling lifecycle fixtures pass.
- [ ] 4.3 If any file under `core/` other than tests changed, run `node scripts/build.mjs` and verify `--check` is clean. Expected: test-only change, no SKILL regen.
- [ ] 4.4 Run `npm run ci` from the repo root and verify it passes.
