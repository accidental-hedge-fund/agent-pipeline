## Context

See `proposal.md` for motivation. Current law and code (validated in this worktree):

- `reapDetachFixture(dir, stateRoot, version)` in `core/test/tugboat.test.ts` sends `SIGTERM` to pids whose `/proc/*/cmdline` contains `dir` or `--milestone v${version}`, and to `playbook.pid` when present. It does not wait for death. Seven lifecycle fixtures then call `fs.rmSync(dir, { recursive: true, force: true })` in `finally`.
- The SIGTERM wait-for-live fixture (`test("SIGTERM during wait-for-live reaps the unconfirmed child before unlock")`) uses `spawn` with piped stdout/stderr, SIGTERMs the detach parent after the unconfirmed child pid file exists, awaits that parent `close`, then `spawnSync` a later `--detach` that leaves a live owning tugboat (`sleep 3600` pipeline stub). Product asserts then `finally` kill-without-wait and `rmSync`. Actions run `33995969315` threw `ENOTEMPTY` at that `rmSync` (line 3127) after green product asserts.
- Completeness today is "kill was sent." Node recursive `rmSync` can throw `ENOTEMPTY` when a child still creates files during the walk. Piped `data` listeners can also keep the tree busy.
- Existing helpers to reuse: `killPids`, `pidsWithCmdlineNeedle`, `waitUntil`, unique `9.99.*` milestones. Product SIGTERM / wait-for-live / re-parent assertions stay load-bearing (`tugboat-thin-ship` signal and wait-for-live scenarios).
- `reapContainment` in `core/scripts/planning-facts.ts` is the Linux cgroup spawn-provider drain (#1472). That is a different spawn surface.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Site symptom:** SIGTERM fixture `ENOTEMPTY` at `tugboat.test.ts:3127` on Actions.
2. **Class:** spawn-real Tugboat lifecycle fixtures that kill owned children and then delete a temp tree those children still mutate. Shared gate: extend `reapDetachFixture` so it owns kill → observe death → close writers → delete.
3. **Next identical fault:** a later detach stub that still writes after SIGTERM hits the same seam. The naive-`rmSync` bite stays red. A `try/catch` on one `finally` is not enough.

## Goals / Non-Goals

**Goals:**

- Extend `reapDetachFixture` (or a thin wrapper next to it in the same file) so callers get kill, death observation, optional stdio close, and temp-tree delete as one seam.
- Bound that wait with a named 2,000 ms deadline and poll at most every 20 ms.
- On deadline with remaining owned pids or a still-mutating tree, fail the test with remaining-pid names. Do not swallow `ENOTEMPTY`.
- Keep SIGTERM product assertions unchanged. Close pipes on that fixture before delete.
- Point all seven current `reapDetachFixture` + immediate `fs.rmSync` callers at the seam.
- Add a helper-level bite: live writer → naive `rmSync` throws `ENOTEMPTY`; shared seam reaps then deletes.

**Non-Goals:**

- Changing Tugboat detach product behavior (`tugboat.sh` traps, admission lock, wait-for-live reap).
- A new cleanup module, `core/scripts/` helper, npm dependency, or generic repo-wide `safeRm`.
- Reusing `reapContainment` / cgroup drain (wrong spawn surface).
- Skipping, quarantining, or marking the SIGTERM fixture flaky.
- Killing processes outside fixture ownership needles.
- Rewriting every `mkdtemp` + `fs.rmSync` in `tugboat.test.ts` that does not spawn a long-lived child (static extract/source tests).
- Projecting cleanup timeout as `needs-human`.

## Decisions

### D1: First holding rung is `reapDetachFixture`, not a new layer

**Decision:** Keep kill needles and add wait-for-death plus temp-tree delete on the existing `reapDetachFixture` path in `core/test/tugboat.test.ts`. Callers pass optional `ChildProcess` handles so the SIGTERM fixture can close stdout/stderr. After death observation, the seam deletes `dir`. Callers drop the separate `fs.rmSync`.

**Why:** All seven failing-class fixtures already enter this helper. The hole is completeness after kill, not missing ownership needles. A second waiter or a one-test `try/catch` is a mole.

**Rejected:** A new `core/scripts/test-tmp-cleanup.ts` module. Extra layer for one test file.

**Rejected:** Teaching `planning-facts.ts` `reapContainment` to delete Node temp dirs. Wrong surface.

**Rejected:** Changing only the SIGTERM `finally`. Sibling fixtures have the same kill-then-`rmSync` shape.

### D2: Completeness observer is owned-pid ESRCH, then delete

**Decision:** After existing `killPids`, poll until `pidsWithCmdlineNeedle(dir)` and `pidsWithCmdlineNeedle(--milestone v${version})` are empty (and `playbook.pid` is `ESRCH` when present), or the named deadline expires. Close optional stdio before that wait returns. Then `fs.rmSync(dir, { recursive: true, force: true })`. Parent `close` of the Node-spawned detach, a fixed sleep, and "kill was sent" are not the observer.

**Why:** `ENOTEMPTY` is a still-mutating tree. Observed death of fixture-owned writers is the gate. The SIGTERM parent `close` does not reap the later live owning tugboat left by the second `--detach`.

**Rejected:** Immediate `rmSync` after `SIGTERM`. That is the Actions hole.

**Rejected:** Infer completeness from missing `delay.woke`. That is a product assertion, not cleanup completeness.

### D3: Named 2,000 ms deadline; poll at most every 20 ms; ENOTEMPTY retries inside the same bound

**Decision:** Name the cleanup deadline 2,000 ms. Poll at most every 20 ms (`waitUntil` already uses 15 ms). If `rmSync` throws `ENOTEMPTY` / `EBUSY` before the deadline, reap again and retry. At deadline with remaining owned pids or a still-throwing delete, throw with remaining-pid names.

**Why:** SIGTERM of `sleep 3600` stubs is usually sub-100 ms locally and raced under Actions load. 2,000 ms is bounded and longer than the observed flake window. Unbounded retry of `ENOTEMPTY` would hang CI. A config key is YAGNI.

**Rejected:** Catch-and-ignore `ENOTEMPTY` as success. Hides a live descendant.

**Rejected:** Unbounded `while (true) rmSync`. Forbidden.

**Rejected:** 1,000 ms only. May be tight when a later `--detach` has just exec'd a new owning tugboat plus the sleep stub.

### D4: Optional ChildProcess handles for writers; ownership needles stay as they are

**Decision:** Extend the seam with an optional list of Node `ChildProcess` objects. For each, destroy/unpipe stdout and stderr and stop `data` listeners. Ownership kill stays `dir` cmdline, `--milestone v${version}`, and `playbook.pid`. Do not scan `/proc` for every descendant of the test worker.

**Why:** The SIGTERM fixture is the one with live pipes. Other callers use `spawnSync` and only need death wait plus delete. Host-wide kill is not ownership-safe.

**Rejected:** `kill(-1)` or kill-by-PPID of the test worker. Too broad.

**Rejected:** Require every caller to pass children. `spawnSync` fixtures have no handle; cmdline needles already find the leftover owning tugboat.

### D5: Bite is a helper-level mutating writer, not a sleep-only repeat of the SIGTERM test

**Decision:** Add a focused test next to the SIGTERM fixture that: (1) starts a writer creating files under a temp tree, (2) asserts naive `fs.rmSync` throws `ENOTEMPTY` (or equivalent), (3) runs the shared seam and asserts the tree is gone and the writer is `ESRCH`. Keep the SIGTERM fixture enabled. Do not mark it flaky. Do not use N sleeps as the sole pass.

**Why:** Issue requires a bite that demonstrates the old race. A concurrent writer is the deterministic `ENOTEMPTY` shape. Repeating the full SIGTERM test 25 times is optional extra evidence, not the load-bearing bite.

**Rejected:** Skip/quarantine the SIGTERM fixture. Issue forbids this.

**Rejected:** Catch `ENOTEMPTY` in that one `finally` and call the test green. Not a class fix.

## Risks / Trade-offs

- **[Risk]** 2,000 ms wait in seven `finally` blocks slows the file under a wedged child.  
  **Mitigation:** Fail closed at the deadline with remaining pids. Do not hang. SIGTERM of sleep stubs should exit well under the bound.

- **[Risk]** Cmdline needles miss a re-parented descendant whose argv no longer contains `dir` or the milestone.  
  **Mitigation:** Existing product tests already record pid files and session/group reap in Tugboat. Cleanup also kills `playbook.pid`. The helper-level writer bite uses a path under `dir` so the `dir` needle matches. Do not broaden to host-wide kill.

- **[Risk]** Naive-`rmSync` bite is itself racy and does not throw `ENOTEMPTY` on a quiet runner.  
  **Mitigation:** Writer loops `mkdir`/`write`/`mkdir` under the tree until killed. If naive delete unexpectedly succeeds, fail the bite for "did not demonstrate the race" rather than skip. Tightening the writer (many files per tick) is allowed; removing the bite is not.

- **[Risk]** Scope creep into `tugboat.sh` signal traps.  
  **Mitigation:** Product SIGTERM assertions already pass on Actions. This change is fixture cleanup only unless a new product leak is proven.

## Migration Plan

1. Land OpenSpec + `reapDetachFixture` completeness + caller switch + bite in one PR for #1470.
2. No install refresh. No GitHub schema change. Tugboat binary unchanged.
3. Rollback: revert the test-file change. No production pin impact.

## Open Questions

- None. Shared seam, completeness observer, 2,000 ms bound, and helper-level bite are locked (D1–D5).
