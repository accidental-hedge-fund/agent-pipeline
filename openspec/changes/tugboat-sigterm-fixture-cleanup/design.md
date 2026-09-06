## Context

See `proposal.md` for motivation. Current law and code (validated in this worktree):

- `reapDetachFixture(dir, stateRoot, version)` in `core/test/tugboat.test.ts` is **synchronous**. It sends `SIGTERM` to pids whose `/proc/*/cmdline` contains `dir` or `--milestone v${version}`, and to `playbook.pid` when present, **without** checking that pid's current argv. It does not wait for death. Seven lifecycle fixtures then call `fs.rmSync(dir, { recursive: true, force: true })` in `finally`. Three of those tests are sync (`admission lock leftover`, `failed wait-for-live releases admission`, `sequential second detach`); four are already async.
- The SIGTERM wait-for-live fixture (`test("SIGTERM during wait-for-live reaps the unconfirmed child before unlock")`) uses `spawn` with piped stdout/stderr, SIGTERMs the detach parent after the unconfirmed child pid file exists, awaits that parent `close`, then `spawnSync` a later `--detach` that leaves a live owning tugboat (`sleep 3600` pipeline stub). Product asserts then `finally` kill-without-wait and `rmSync`. Actions run `33995969315` threw `ENOTEMPTY` at that `rmSync` (line 3127) after green product asserts.
- Completeness today is "kill was sent." Node recursive `rmSync` can throw `ENOTEMPTY` when a child still creates files during the walk. Piped `data` listeners are hygiene only: closing them does not stop a live descendant from mutating files. The load-bearing gate is verified fixture-owned **non-zombie** process exit.
- Existing helpers to reuse: `killPids`, `pidsWithCmdlineNeedle`, `procsWithNeedle`, `waitUntil` (async, **15 ms** poll, named deadline). Unique `9.99.*` milestones. Product SIGTERM / wait-for-live / re-parent assertions stay load-bearing (`tugboat-thin-ship` signal and wait-for-live scenarios).
- `reapContainment` in `core/scripts/planning-facts.ts` is the Linux cgroup spawn-provider drain (#1472). That is a different spawn surface.
- PID-reuse and `/proc/<pid>/stat` parse after last `)` already exist as product/test law: `getProcessStartTime` in `core/scripts/lock.ts`, `admission_owner_identity` in `examples/supervisor/shell/tugboat.sh`, and the live-ship probe tests that reject a recycled `playbook.pid` whose argv is not a live ship.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Site symptom:** SIGTERM fixture `ENOTEMPTY` at `tugboat.test.ts:3127` on Actions.
2. **Class:** spawn-real Tugboat lifecycle fixtures that kill owned children and then delete a temp tree those children still mutate. Shared gate: extend `reapDetachFixture` so it owns kill → observe death → close writers → delete.
3. **Next identical fault:** a later detach stub that still writes after SIGTERM hits the same seam. The naive-`rmSync` bite stays red. A `try/catch` on one `finally` is not enough.

## Goals / Non-Goals

**Goals:**

- Change `reapDetachFixture` to an **awaited async** cleanup API. All seven callers' `finally` blocks `await` it. Sync tests that call it become `async`.
- After ownership kills, wait until fixture-owned **live non-zombie** processes are gone, close optional stdio, then delete the temp tree **inside the seam**. Callers drop the trailing `fs.rmSync`. No `reapDetachFixture(...); fs.rmSync(...)` pair remains.
- Bound that wait with a named 2,000 ms deadline. Poll interval is `waitUntil`'s existing **15 ms** (minimum = maximum = 15 ms). Do not introduce a second 20 ms constant.
- `playbook.pid` is an ownership candidate only: signal it after current `/proc/<pid>/cmdline` matches the fixture dir or unique `--milestone v${version}`. On timeout, name remaining pids with ownership source and argv.
- Treat zombies as not mutating. Do not use `kill(pid, 0)` as the still-mutating test.
- On deadline with remaining live owned pids or a still-mutating tree, fail the test with remaining-pid names. Do not swallow `ENOTEMPTY`.
- Keep SIGTERM product assertions unchanged. Close pipes on that fixture before delete. Optional `ChildProcess` handles are no-ops when missing (test failed before `spawn`).
- Point all seven current `reapDetachFixture` + immediate `fs.rmSync` callers at the seam.
- Add a helper-level bite with a writer-ready handshake and a bounded contention loop: live writer → naive `rmSync` throws `ENOTEMPTY`; shared seam reaps then deletes. If the naive delete never throws by its deadline, fail with diagnostics.

**Non-Goals:**

- Changing Tugboat detach product behavior (`tugboat.sh` traps, admission lock, wait-for-live reap).
- A new cleanup module, `core/scripts/` helper, npm dependency, or generic repo-wide `safeRm`.
- Reusing `reapContainment` / cgroup drain (wrong spawn surface).
- Skipping, quarantining, or marking the SIGTERM fixture flaky.
- Killing processes outside fixture ownership needles.
- Rewriting every `mkdtemp` + `fs.rmSync` in `tugboat.test.ts` that does not spawn a long-lived child (static extract/source tests).
- Projecting cleanup timeout as `needs-human`.
- Changing `waitUntil`'s 15 ms interval for other callers.
- Escalating leftover owned pids to `SIGKILL` (that would hide a wedged descendant). Fail closed with names after `SIGTERM`.

## Decisions

### D1: First holding rung is `reapDetachFixture`, not a new layer

**Decision:** Keep kill needles and add wait-for-death plus temp-tree delete on the existing `reapDetachFixture` path in `core/test/tugboat.test.ts`. Callers pass optional `ChildProcess` handles so the SIGTERM fixture can close stdout/stderr. After death observation, the seam deletes `dir`. Callers drop the separate `fs.rmSync`.

**Why:** All seven failing-class fixtures already enter this helper. The hole is completeness after kill, not missing ownership needles. A second waiter or a one-test `try/catch` is a mole.

**Rejected:** A new `core/scripts/test-tmp-cleanup.ts` module. Extra layer for one test file.

**Rejected:** Teaching `planning-facts.ts` `reapContainment` to delete Node temp dirs. Wrong surface.

**Rejected:** Changing only the SIGTERM `finally`. Sibling fixtures have the same kill-then-`rmSync` shape.

### D2: Completeness observer is live non-zombie owned-pid exit, then delete

**Decision:** After existing `killPids`, poll until no **live non-zombie** pid matches `pidsWithCmdlineNeedle(dir)` or `pidsWithCmdlineNeedle(--milestone v${version})`, and the owned `playbook.pid` (when present and argv-verified) is gone or zombie. Close optional stdio before that wait returns. Then `fs.rmSync(dir, { recursive: true, force: true })`. Parent `close` of the Node-spawned detach, a fixed sleep, and "kill was sent" are not the observer.

Live vs gone: parse `/proc/<pid>/stat` after the last `)` (same split as `getProcessStartTime` in `core/scripts/lock.ts` and `admission_owner_identity` in `tugboat.sh`). Field 3 state `Z` is a zombie: not mutating, treat as complete. Missing `/proc/<pid>/stat` is gone. `kill(pid, 0)` MUST NOT be the still-mutating test (it returns success on zombies). Capture an isolated group from any currently argv-verified member, not only the original group leader. When the leader is already gone, authorize the group from that member's current PID/start-time identity while excluding the test worker's own group; retain the group after the marked member exits so unmarked descendants remain observable.

**Why:** `ENOTEMPTY` is a still-mutating tree. Observed death of fixture-owned writers is the gate. The SIGTERM parent `close` does not reap the later live owning tugboat left by the second `--detach`. Closing `data` listeners is not that gate.

**Rejected:** Immediate `rmSync` after `SIGTERM`. That is the Actions hole.

**Rejected:** Infer completeness from missing `delay.woke`. That is a product assertion, not cleanup completeness.

**Rejected:** `kill(pid, 0) === throw ESRCH` as the only death observer.

### D3: Named 2,000 ms deadline; poll interval is `waitUntil`'s 15 ms; ENOTEMPTY retries inside the same bound

**Decision:** Name the cleanup deadline `DETACH_FIXTURE_CLEANUP_DEADLINE_MS = 2_000`. Reuse `waitUntil` for death observation. That helper sleeps **15 ms** per iteration (minimum interval = 15 ms, maximum interval = 15 ms). Do not add a 20 ms poll constant. Do not change `waitUntil` for other callers. Before every `rmSync`, reap and observe that no owned process remains. If `rmSync` throws `ENOTEMPTY` / `EBUSY` before the deadline, reap, await observed exit, and only then retry. After a successful delete, observe ownership once more and retry deletion if a late writer recreated the tree. At deadline with remaining **live** owned pids or a still-throwing delete, throw with remaining-pid names, ownership source (`cmdline:dir` / `cmdline:milestone` / `playbook.pid`), and argv.

**Why:** The previous plan said "at most every 20 ms" while `waitUntil` already polls every 15 ms. That is a contradiction. The intended bound is the existing helper: 15 ms. SIGTERM of `sleep 3600` stubs is usually sub-100 ms locally and raced under Actions load. 2,000 ms is bounded and longer than the observed flake window. Unbounded retry of `ENOTEMPTY` would hang CI.

**Rejected:** A second 20 ms interval next to `waitUntil`'s 15 ms.

**Rejected:** Catch-and-ignore `ENOTEMPTY` as success. Hides a live descendant.

**Rejected:** Unbounded `while (true) rmSync`. Forbidden.

**Rejected:** 1,000 ms only. May be tight when a later `--detach` has just exec'd a new owning tugboat plus the sleep stub.

### D4: Optional ChildProcess handles for writers; `playbook.pid` is argv-verified

**Decision:** Extend the seam with an optional list of Node `ChildProcess` objects. Missing, undefined, or pre-spawn handles are no-ops (do not throw, do not mask the original assertion). For each present handle, destroy/unpipe stdout and stderr and stop `data` listeners. Ownership kill stays:

1. cmdline contains `dir`
2. cmdline contains `--milestone v${version}`
3. pid recorded in `playbook.pid` **only after** current `/proc/<pid>/cmdline` contains `dir` or the unique `--milestone v${version}` coordinate

If `playbook.pid` names a live pid whose argv does not match, do not signal it (PID reuse). Do not scan `/proc` for every descendant of the test worker.

**Why:** The SIGTERM fixture is the one with live pipes. Other callers use `spawnSync` and only need death wait plus delete. Bare `process.kill(playbookPid, SIGTERM)` is the same recycled-pid hole the live-ship probe already rejects. Host-wide kill is not ownership-safe.

**Rejected:** `kill(-1)` or kill-by-PPID of the test worker. Too broad.

**Rejected:** Require every caller to pass children. `spawnSync` fixtures have no handle; cmdline needles already find the leftover owning tugboat.

**Rejected:** Signal `playbook.pid` without argv verification.

### D5: Bite is a helper-level mutating writer with handshake and bounded contention

**Decision:** Add a focused test next to the SIGTERM fixture that:

1. Starts a writer whose argv contains the temp dir (script path under `dir`).
2. Writer creates an initial nested tree, then writes a **ready file**, then mutates forever (`mkdir` + write unique nested paths; hold one directory fd open).
3. Test `waitUntil` the ready file exists (2,000 ms).
4. Runs a **bounded contention loop** (named deadline 1,000 ms, 15 ms `waitUntil` interval): naive `fs.rmSync(dir, { recursive: true, force: true })` until it throws `ENOTEMPTY` or `EBUSY`. If the deadline expires without that throw, **fail** with diagnostics (writer pid, live/zombie/gone, cmdline, tree listing if present, last `rmSync` outcome). Do not skip. Do not treat a quiet successful delete as a pass.
5. Runs the shared async seam and asserts the writer is gone/zombie and the temp tree is gone.

Keep the SIGTERM fixture enabled. Do not mark it flaky. Do not use N sleeps as the sole pass.

**Why:** A single `rmSync` against a writer is still probabilistic. The handshake proves the writer is mutating before the first delete. The bounded loop is the explicit contention strategy. Failing with diagnostics is required so the bite cannot become a new flake.

**Rejected:** Skip/quarantine the SIGTERM fixture. Issue forbids this.

**Rejected:** Catch `ENOTEMPTY` in that one `finally` and call the test green. Not a class fix.

**Rejected:** One `rmSync` with no handshake as the only demonstration.

### D6: `reapDetachFixture` is awaited async; all seven `finally` blocks `await` it

**Decision:** Signature becomes `async function reapDetachFixture(opts): Promise<void>` (dir, stateRoot, version, optional children). It owns kill → observe death → close writers → delete. All seven callers:

1. concurrent detach race
2. stale-admission / leftover lock
3. failed wait-for-live delayed-child reap
4. SIGTERM wait-for-live (pass the spawned child when defined)
5. wait-for-live expiry re-parent reap
6. failed wait-for-live releases admission
7. sequential detach

Each `finally` is `await reapDetachFixture(...)`. The three currently sync tests become `async`. No caller keeps a trailing `fs.rmSync`.

**Why:** `waitUntil` is async. A sync helper cannot observe death. Plan review required this migration to be explicit.

**Rejected:** Keep a sync `reapDetachFixture` and sleep inside it.

**Rejected:** A second wrapper name that still leaves `fs.rmSync` in callers.

## Risks / Trade-offs

- **[Risk]** 2,000 ms wait in seven `finally` blocks slows the file under a wedged child.  
  **Mitigation:** Fail closed at the deadline with remaining pids, ownership source, and argv. Do not hang. SIGTERM of sleep stubs should exit well under the bound.

- **[Risk]** Cmdline needles miss a re-parented descendant whose argv no longer contains `dir` or the milestone.  
  **Mitigation:** Capture isolated process groups by leader pid plus `/proc` start time while an argv-owned leader exists. Continue observing members when that leader exits; if the leader pid exists, require the captured start time so PID reuse cannot validate a different group. Cleanup also kills argv-verified `playbook.pid`. Do not broaden to host-wide kill.

- **[Risk]** Naive-`rmSync` bite is itself racy and does not throw `ENOTEMPTY` on a quiet runner.  
  **Mitigation:** Ready-file handshake plus bounded contention loop. If naive delete never throws by the 1,000 ms bite deadline, fail with diagnostics. Tightening the writer (more files per tick, held fd) is allowed; removing the bite or skipping on timeout is not.

- **[Risk]** Cleanup throw in `finally` masks an earlier assertion.  
  **Mitigation:** Optional children are no-ops when missing, so a failure before `spawn` does not throw from handle close. Needle scans on an unused unique milestone are empty; delete of a partial tree succeeds. A cleanup throw after a product assertion failure means leftover live owned pids — that fail-closed result is the class defect, not a mask of a missing handle.

- **[Risk]** Scope creep into `tugboat.sh` signal traps.  
  **Mitigation:** Product SIGTERM assertions already pass on Actions. This change is fixture cleanup only unless a new product leak is proven.

## Migration Plan

1. Land OpenSpec + async `reapDetachFixture` completeness + caller `await` switch + handshake bite in one PR for #1470.
2. After the `core/test/` edit, run `node scripts/build.mjs` (any `core/` change, including tests).
3. No install refresh. No GitHub schema change. Tugboat binary unchanged.
4. Rollback: revert the test-file change. No production pin impact.

## Open Questions

- None. Async seam, 15 ms `waitUntil` poll, argv-verified `playbook.pid`, zombie treatment, handshake bite, and always-run `build.mjs` are locked (D1–D6).
