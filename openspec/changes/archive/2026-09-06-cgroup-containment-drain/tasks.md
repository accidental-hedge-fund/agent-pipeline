## 1. Injected drain-contract tests

- [x] 1.1 Add an injected `ProviderContainment` test where `remainingPids()` stays non-empty through the drain deadline, and verify the spawn result is not success, `descendants_remaining` is true, and stderr (or equivalent result text) identifies the cgroup dir and remaining PIDs. Confirm the test fails before the drain timeout diagnostics exist.
- [x] 1.2 Add an injected test where `remainingPids()` is non-empty at child `close` and becomes empty after `killRemaining()`, and verify the result is `descendants_remaining: false`. Confirm the current pre-kill snapshot OR would fail this test.
- [x] 1.3 Keep the existing injected test that `killRemaining()` still runs when `remainingPids()` looks empty, and verify `killed >= 1` still holds after the drain change.
- [x] 1.4 Add an injected test where `remainingPids()` throws (unreadable cgroup) and verify the spawn result is not success, `descendants_remaining` is true, and typed diagnostics identify the cgroup.
- [x] 1.5 Add an injected test where close precedes `timeoutMs` and drain completion follows it, and verify `timed_out` is false.
- [x] 1.6 Add a regression with pre-filled stderr and a small cap where observation still identifies the cgroup and remaining PIDs via dedicated typed evidence.

## 2. Linux cgroup spawn-provider drain

- [x] 2.1 In `defaultSpawnProvider` / `reapContainment`, introduce a named 1,000 ms containment-drain deadline and poll `remainingPids()` at most every 10 ms. Verify the named constant is 1,000 and no poll path uses an unbounded loop or unbounded sleep.
- [x] 2.2 After the existing `killRemaining()` call, report success only from a fresh empty `remainingPids()` read. Verify task 1.2 passes and a still-non-empty read is never success.
- [x] 2.3 On deadline expiry with remaining members, keep `descendants_remaining: true`, write diagnostics that name `containment.dir` and the remaining PIDs, and do not set `timed_out` or `spawn_error` for that path. Verify task 1.1 passes and observation still maps leftovers to failure class `containment`.
- [x] 2.4 Apply the empty-cgroup drain only when the provider created a cgroup (`containment.dir`). Verify the no-nested-cgroup setsid test still relies on the subreaper and is not rewritten into a cgroup drain.
- [x] 2.5 Treat a failed remaining-PID observation as not-empty, clear the provider runtime timer on child `close`/`error` before the drain, and expose cgroup/remaining-PID diagnostics as dedicated typed evidence independent of stderr capture.

## 3. Daemonized delayed-write fixture

- [x] 3.1 Change the existing setsid delayed-write fixture so the descendant emits a positive readiness or acknowledgement signal and the parent waits for that signal before printing JSON and exiting. Verify the parent cannot finish before the signal exists.
- [x] 3.2 Keep the delayed-write absence assertion and its 600 ms window unchanged. Verify `pwned.txt` is absent after a successful provider return and that the wait is not increased.
- [x] 3.3 Do not skip, quarantine, or weaken `defaultSpawnProvider cgroup containment kills a setsid daemon before a delayed write lands`. Verify the test name and delayed-write assertion remain.

## 4. Gates and evidence

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` and verify `--check` is clean. Update generated docs only if an existing spawn-provider or diagnostics page already states cleanup timing.
- [x] 4.2 Run `openspec validate cgroup-containment-drain` and verify it passes.
- [x] 4.3 From `core/`, run the focused regression 25 consecutive times on Linux cgroup v2 (`node --test --experimental-strip-types --test-name-pattern 'cgroup containment kills a setsid daemon before a delayed write lands' test/planning-facts.test.ts`) and verify all 25 pass.
- [x] 4.4 Run `npm run ci` from the repo root and verify it passes, including the injected drain tests and the delayed-write bite.
