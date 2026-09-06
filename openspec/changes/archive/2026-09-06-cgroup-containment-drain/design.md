## Context

See `proposal.md` for motivation. Current law and code (validated in this worktree):

- `defaultSpawnProvider` in `core/scripts/planning-facts.ts` is the Linux cgroup spawn provider. After the direct child `close`/`error`/kill-follow-up, `reapContainment` always calls `killRemaining` (cgroup.kill or per-pid SIGKILL), then polls `remainingPids()` until empty or `PROVIDER_KILL_GRACE_MS + PROVIDER_KILL_FOLLOWUP_MS` (200 + 200 = 400 ms) at 10 ms intervals.
- Completeness today is not a fresh empty-cgroup observation: the function returns `remaining.length > 0 || remainingPids().length > 0`, so a pre-kill snapshot can mark leftovers even after the cgroup drains, and an empty first `remainingPids()` read ends the wait immediately. Under load, `cgroup.procs` can look empty while a `setsid` grandchild is still starting.
- Observation already maps `descendants_remaining` to typed `planning-facts-provider-contract` with failure class `containment`. Runtime ceiling uses `timed_out`. Those classes stay distinct.
- Admission already waits up to 1,000 ms for the wrapper pid to appear in the cgroup (`waitUntilPidInCgroup`). Nested mkdir may return EACCES; `NOOP_PROVIDER_CONTAINMENT` plus the subreaper trampoline remain the non-cgroup path.
- The bite is `defaultSpawnProvider cgroup containment kills a setsid daemon before a delayed write lands` in `core/test/planning-facts.test.ts`. The fixture backgrounds `setsid` and immediately prints JSON (no readiness signal), then asserts `pwned.txt` is absent after a 600 ms sleep. That window must not grow.

**Class vs site (engine-dogfood bar):** this is a **class** fix.

1. **Site symptom:** full-suite load, the setsid delayed-write fixture in `planning-facts.test.ts`.
2. **Class:** Linux cgroup spawn-provider cleanup-completeness. Shared gate: `reapContainment` after existing kill. Every spawn that uses that provider inherits the contract.
3. **Next identical fault:** a daemonized descendant that still runs after kill. It hits the same drain. The provider either observes an empty cgroup or fails closed with cgroup and remaining-PID diagnostics. A new path-local mole is not required.

## Goals / Non-Goals

**Goals:**

- Extend the existing `reapContainment` wait so a successful return is a fresh empty-cgroup observation.
- Bound that wait with a named 1,000 ms deadline and poll interval of at most 10 ms.
- On deadline with remaining members, fail closed with typed diagnostics that name the cgroup and remaining PIDs.
- Make the existing delayed-write fixture acknowledge daemon readiness before the parent may finish, without widening the 600 ms assertion window.

**Non-Goals:**

- A new cleanup module, process runner, or containment API.
- Changing `runCapped`, harness descendant kill, or non-Linux spawn.
- Requiring nested cgroup v2 where mkdir is unavailable.
- Skipping the kill, widening the delayed-write window, skip/quarantine, or a merge/release exception.
- Escalating kill outside the provider-created cgroup.
- Projecting drain timeout as `needs-human` or as provider runtime `timed_out`.

## Decisions

### D1: First holding rung is `reapContainment`, not a new layer

**Decision:** Keep kill, poll, and return on the existing `reapContainment` path inside `defaultSpawnProvider`. Reuse `ProviderContainment.dir`, `remainingPids()`, and `killRemaining()`. Add a named drain-deadline constant next to `PROVIDER_KILL_GRACE_MS` / `PROVIDER_KILL_FOLLOWUP_MS` and the 1,000 ms admission wait.

**Why:** The defect is when that function reports complete. Every real spawn already enters it. A second waiter, a test-only sleep, or a caller-local guard would be a mole.

**Rejected:** A new `ContainmentDrain` type or cleanup helper module. Extra layer for one wait.

**Rejected:** Changing only the test fixture (skip, sleep, or window). That leaves the provider contract unchanged.

**Rejected:** Teaching `runCapped` cgroup drain. Out of scope; different spawn surface.

### D2: Completeness observer is a fresh empty `remainingPids()` after kill

**Decision:** After the existing `killRemaining()` call, poll `remainingPids()` until a fresh read returns `[]` or the named deadline expires. Parent `close`, the pre-kill snapshot, a fixed sleep, and delayed-write file absence are not the observer. If the fresh read is empty before the deadline, the return is success (`descendants_remaining` false). The pre-kill snapshot MUST NOT force `descendants_remaining` true after the cgroup has drained.

**Why:** Empty cgroup is known complete. The current `remaining.length > 0 || ...` uses a stale pre-kill list and can both false-fail (leftovers that then died) and false-complete (empty first read while a grandchild is still starting).

**Rejected:** Treat parent exit as complete, then sleep. Sleep is not an observer.

**Rejected:** Infer completeness from missing `pwned.txt`. That is the regression bite, not the production gate.

### D3: Named 1,000 ms drain; poll at most every 10 ms

**Decision:** Name the drain deadline 1,000 ms (same magnitude as cgroup admission). Keep poll sleeps at most 10 ms (current poll is already 10 ms). The 200 ms SIGTERM grace and 200 ms kill follow-up on the direct child stay for timeout/ceiling terminate; they are not the containment-drain deadline.

**Why:** 400 ms combined grace is shorter than the fixture's 400 ms delayed write and is not a named containment-drain. 1,000 ms is bounded, already used for admission, and exceeds the current 400 ms window. Unbounded polling is forbidden.

**Rejected:** Reuse 400 ms grace+follow-up as the drain. Too short under load; not the named bound in the issue.

**Rejected:** Config key for the deadline. One named constant is enough.

### D4: Drain timeout reuses `descendants_remaining` plus diagnostics; not `timed_out`

**Decision:** Deadline with remaining PIDs returns a non-success spawn result: `descendants_remaining: true` and stderr (or equivalent result text) that identifies `containment.dir` and the remaining PIDs. Observation keeps `fail("containment", ...)`. Do not set `timed_out` (runtime ceiling). Do not set `spawn_error` (spawn construction). Do not project `needs-human`.

**Why:** Remaining PIDs at deadline are not known complete and not known absent. The observation layer already fails leftover descendants as `containment`. Runtime `timed_out` would let optional providers continue as unavailable for the wrong reason.

**Rejected:** A new result field or error class. Extra API when `descendants_remaining` plus stderr already fail closed.

**Rejected:** Treat drain timeout as success. That is a waiver.

### D5: Fixture emits readiness; keep the 600 ms delayed-write window

**Decision:** Change only the existing setsid delayed-write fixture so the descendant writes a positive ready/ack signal (for example a ready file) and the parent waits for that signal before printing JSON and exiting. Keep `await new Promise((r) => setTimeout(r, 600))` as the assertion window. Do not lengthen it.

**Why:** Without readiness, the parent can finish before the daemon exists, so an empty cgroup is a false complete. Readiness makes the delayed write a real post-cleanup race. The 600 ms window is the bite; widening it hides the race.

**Rejected:** Increase the sleep to 1,000 ms+ to outwait the drain. That is a path-local mole.

**Rejected:** Skip or quarantine the test on CI load.

### D6: No new irreversible operation

**Decision:** The drain waits and reports on the cgroup the provider already created. Kill scope stays `killRemaining()` on that cgroup (cgroup.kill or those PIDs). Timeout lists remaining PIDs; it does not kill processes outside that cgroup and does not add `rmdir --force` or host-wide kill.

**Why:** Grill irreversible-operations: no new host-wide kill, cgroup destroy, or force-remove.

### D7: Non-cgroup path stays on the subreaper

**Decision:** When `createCgroupContainment` is unavailable, keep `NOOP_PROVIDER_CONTAINMENT` and the subreaper trampoline. The named empty-cgroup drain applies only when the provider created a cgroup (`containment.dir`). The existing no-nested-cgroup delayed-write test stays as subreaper coverage and is not rewritten into a cgroup drain.

**Why:** The issue forbids requiring cgroup v2 where it is unavailable.

## Risks / Trade-offs

- **[Risk] Empty `cgroup.procs` while a grandchild is still being admitted → Mitigation:** readiness in the fixture so the descendant exists before parent exit; always kill before drain; poll up to 1,000 ms; fail closed if PIDs remain.
- **[Risk] Drain adds up to 1,000 ms on the leftover-descendant path → Mitigation:** return immediately on a fresh empty read; the extra wait applies only while members remain. Happy-path empty cgroup does not sleep the full deadline.
- **[Risk] Pre-kill leftover flag currently fails even after drain → Mitigation:** D2 uses only the fresh post-kill read so a drained cgroup is success. Injected tests that want leftover failure keep `remainingPids()` non-empty through the deadline.
- **[Risk] 25-run streak is load-sensitive → Mitigation:** keep the delayed-write bite; do not skip. Run the focused test 25 times as engine-owned verification, not a human attestation. Exact-head GitHub CI must still pass.
- **[Trade-off] Diagnostics live on stderr / result text rather than a new typed field →** observation already consumes `descendants_remaining`. A new field would be a second contract for one diagnostic string.

## Migration Plan

No schema, CLI, or config migration. Land on the normal pipeline merge path. Rollback is revert of the provider drain and fixture readiness; no skip or quarantine.

## Open Questions

None. Drain bounds, observer, timeout class, kill scope, fixture readiness, and CI evidence are settled in the issue decisions.
