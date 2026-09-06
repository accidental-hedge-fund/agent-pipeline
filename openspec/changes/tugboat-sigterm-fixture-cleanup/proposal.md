## Why

GitHub Actions run `33995969315` failed `SIGTERM during wait-for-live reaps the unconfirmed child before unlock` (`core/test/tugboat.test.ts:3002`) after the product assertions passed. Final `fs.rmSync(..., { recursive: true, force: true })` at line 3127 raced a still-changing temp tree and threw `ENOTEMPTY`. The same candidate passed local CI. That is a class defect in Tugboat spawn-real lifecycle fixture cleanup, not a SIGTERM-product hole and not a flake to skip.

## What Changes

- Make spawn-real Tugboat lifecycle fixture cleanup complete only after it reaps and awaits every fixture-owned process, and after it closes fixture writers and watchers, then deletes the temp tree.
- Change `reapDetachFixture` in `core/test/tugboat.test.ts` to an awaited async helper so kill, death observation (`waitUntil`, 15 ms poll, 2,000 ms deadline), stdio close, and temp-tree delete live in one ownership-safe helper. All seven callers `await` it. Do not add a second cleanup module, a `core/scripts/` helper, or a cgroup-provider drain.
- Keep the SIGTERM product assertions (fail closed, no `detached tugboat ship`, unconfirmed child dead, later detach admits exactly one live ship). Cleanup SHALL NOT hide a live descendant or swallow `ENOTEMPTY` without a reap.
- Apply that shared seam to the other `reapDetachFixture` callers that still `fs.rmSync` immediately after an un-awaited kill. The seam owns delete; no kill-then-`rmSync` pair remains.
- Add a biting regression with a writer-ready handshake and bounded contention: naive `fs.rmSync` throws `ENOTEMPTY`; the shared seam reaps then deletes. Do not skip, quarantine, or mark the SIGTERM fixture flaky.

No **BREAKING** change to public CLI verbs, Tugboat detach product behavior, or host SKILL pages.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `tugboat-thin-ship`: spawn-real Tugboat lifecycle fixtures SHALL own a shared cleanup seam that reaps fixture-owned processes, awaits their death, closes writers and watchers, then deletes the temp tree; the SIGTERM wait-for-live fixture stays enabled and SHALL NOT fail on `ENOTEMPTY` after green product assertions.

## Impact

- **Class vs site:** class is spawn-real Tugboat lifecycle fixtures that SIGTERM-or-kill owned children and then `fs.rmSync` a temp tree those children still mutate. Site evidence is the SIGTERM fixture at `core/test/tugboat.test.ts:3127` on Actions run `33995969315`. Shared gate is `reapDetachFixture` (already used by the concurrent detach, wait-for-live, re-parent, and sequential-detach fixtures).
- **Reuse first:** extend `reapDetachFixture` plus existing `killPids` / `pidsWithCmdlineNeedle` / `procsWithNeedle` / `waitUntil`. Do not reuse `reapContainment` in `planning-facts.ts` (cgroup spawn provider). Do not invent a generic `safeRm` package.
- **Code:** `core/test/tugboat.test.ts` only, unless a tiny shared test helper already in that file is the natural place. Tugboat product `examples/supervisor/shell/tugboat.sh` stays unchanged unless a real product leak is proven.
- **Docs / SKILL:** none. Host SKILL freshness still follows `node scripts/build.mjs` after any `core/` edit, including this test-only change.
- **Authority:** no skip, quarantine, merge, or release exception. Exact-head GitHub CI must pass.

## Acceptance criteria

- [ ] The SIGTERM wait-for-live fixture reaps and awaits every process it spawned, and closes stdout/stderr writers and watchers, before it deletes its temp tree.
- [ ] After green product assertions, that fixture's cleanup does not throw `ENOTEMPTY` (or any other unlink error caused by a still-mutating tree).
- [ ] Cleanup is ownership-safe: it kills only fixture-owned pids (temp-dir needle, `--milestone v${version}`, recorded `playbook.pid` after current argv still matches). It does not kill unrelated host processes, including a reused pid in `playbook.pid`.
- [ ] Cleanup is bounded: wait and `ENOTEMPTY` retry use a named 2,000 ms deadline and `waitUntil`'s 15 ms poll. Unbounded polling and unbounded sleeps are forbidden.
- [ ] If live owned pids remain or the tree is still mutating at the deadline, cleanup fails closed and names remaining pids with ownership source and argv. It does not swallow the error or hide a live descendant. Zombies are not treated as still mutating.
- [ ] Existing SIGTERM product assertions stay: fail closed, no `detached tugboat ship`, unconfirmed child `ESRCH`, later detach admits exactly one live ship.
- [ ] A helper-level bite with a writer-ready handshake and bounded contention proves naive `fs.rmSync` throws `ENOTEMPTY` while a writer mutates the tree, and the shared seam then reaps and deletes. If the naive delete never throws by its deadline, the bite fails with diagnostics.
- [ ] Other `reapDetachFixture` lifecycle fixtures use that same seam instead of kill-then-immediate-`fs.rmSync`.
- [ ] The SIGTERM fixture is not deleted, skipped, or marked flaky.
- [ ] `openspec validate tugboat-sigterm-fixture-cleanup` and `npm run ci` pass. Exact-head GitHub CI is green.

## Class vs site (engine / ship-path dogfood)

| Question | Answer |
|----------|--------|
| Class vs site? | **Class:** spawn-real Tugboat lifecycle fixtures that kill owned children and then delete a temp tree those children still write. Completeness is observed death plus closed writers, then delete. **Site:** SIGTERM wait-for-live fixture `ENOTEMPTY` at `tugboat.test.ts:3127`. |
| Shared surface? | `reapDetachFixture` in `core/test/tugboat.test.ts`. All current callers that `fs.rmSync` after that helper inherit the contract. |
| Next identical fault? | A later detach stub that still writes after SIGTERM hits the same seam. Naive `fs.rmSync` bite stays red. A new path-local `try/catch` on one `finally` is not enough. |
