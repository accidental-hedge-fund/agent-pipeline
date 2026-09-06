## Why

The Linux cgroup spawn provider reports cleanup complete before it observes descendant termination. Under full-suite load, a `setsid` daemon can write after that report. This is a shared cleanup-completeness class: every spawn that uses that provider inherits the same contract. The next identical fault is a daemonized descendant that still runs after kill; that fault must hit the same drain, not a new path-local mole.

## What Changes

- The Linux cgroup spawn provider becomes the shared cleanup-complete gate for descendant containment. The change is not limited to one test path.
- After existing kill, the provider reports success only after a fresh observation that the relevant cgroup is empty. Parent exit, a fixed sleep, and delayed-write file absence are not the completeness observer.
- The containment drain uses a named 1,000 ms deadline and polls at most every 10 ms. Unbounded polling and unbounded sleeps are forbidden.
- If the drain deadline expires with remaining members, the provider returns a typed timeout or error that identifies the cgroup and remaining PIDs. Typed timeout is a closed failure, not a waiver and not a human hold.
- The provider never returns success while known descendants remain. The drain does not skip the kill. The drain does not escalate to a kill of processes outside the provider-created cgroup.
- The existing daemonized-descendant fixture emits a positive readiness or acknowledgement signal. The parent operation may finish only after that signal.
- After successful cleanup, the delayed marker file is absent. The delayed-write assertion window is not increased. The existing bite stays.
- Non-Linux spawn, the general process runner (`runCapped`), and unrelated fixtures stay unchanged. The change does not require cgroup v2 where it is unavailable.

No **BREAKING** change to public CLI verbs or host SKILL pages.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `planning-facts`: the Linux cgroup spawn provider reports cleanup complete only after a fresh empty-cgroup observation; drain deadline expiry is a typed closed failure with cgroup and remaining-PID diagnostics; the daemonized-descendant regression fixture acknowledges readiness before the parent may finish.

## Impact

- **Class vs site:** the class defect is cleanup-complete reported before descendant termination is observed. Issue #1472 and `core/test/planning-facts.test.ts` are regression evidence. The shared gate is `defaultSpawnProvider` / `reapContainment` in `core/scripts/planning-facts.ts`.
- **Reuse first:** extend the existing `reapContainment` wait on `ProviderContainment.remainingPids` after `killRemaining`. Do not add a second cleanup layer, a new process runner, or a test-only sleep/window mole.
- **Code:** `core/scripts/planning-facts.ts` (Linux cgroup spawn provider cleanup-complete observation) and `core/test/planning-facts.test.ts` (existing setsid delayed-write fixture plus injected drain-timeout coverage).
- **Docs / SKILL:** no new CLI verb and no new SKILL page. Update generated docs only if an existing spawn-provider or diagnostics page already states cleanup timing. Host SKILL freshness still follows `node scripts/build.mjs` after any `core/` edit.
- **Authority:** no merge, release, skip, or quarantine exception. Exact-head GitHub CI must pass with the existing delayed-write bite intact. Drain timeout does not project a human hold.

## Acceptance criteria

- [ ] The Linux cgroup spawn provider is the shared cleanup-complete gate for descendant containment. The change is not limited to one test path.
- [ ] The regression fixture emits a positive readiness or acknowledgement signal. The parent operation may finish only after that signal.
- [ ] After a successful provider return, the provider has observed the relevant cgroup as empty.
- [ ] If the drain deadline expires with remaining members, the provider returns a typed timeout or error. That output identifies the cgroup and remaining PIDs.
- [ ] The provider never returns success while known descendants remain.
- [ ] The containment drain uses a named 1,000 ms deadline. Polling intervals are at most 10 ms.
- [ ] After successful cleanup, the delayed marker file is absent. The delayed-write assertion window is not increased.
- [ ] The focused regression `defaultSpawnProvider cgroup containment kills a setsid daemon before a delayed write lands` passes 25 consecutive executions on Linux cgroup v2.
- [ ] `npm run ci` passes.
- [ ] Exact-head GitHub CI passes.
