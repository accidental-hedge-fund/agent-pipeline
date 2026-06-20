## Context

`runCapped` in `harness.ts` already has a `killProcessGroup` option. When `true`, it spawns the child with `detached: true` (creating a new OS process group) and on timeout calls `process.kill(-child.pid, signal)` (negative PID = signal the whole group). `invoke()`, the public entry point called by all pipeline stages, never passes this option — so the `killProcessGroup` path is dead code in production.

## Goals / Non-Goals

**Goals**
- Enable process-group killing for all harness types by passing `killProcessGroup: true` from `invoke()`.
- Prove the fix with a regression test that exercises the grandchild-kill path.

**Non-Goals**
- Configuring the timeout or grace period (5 s hardcoded SIGKILL delay is adequate).
- Adding per-harness-type or per-config opt-out (the always-on default is correct; detached spawning is inert for successful exits).
- Changing any other `runCapped` option or its signature.

## Decisions

**Decision: always-on, no config flag.**
The `detached` spawn option has no observable effect on normal exits — the child's exit code, stdout, stderr, and duration are identical. Adding a config knob (`kill_process_group: bool`) would introduce optionality where none is warranted; the correct behavior is unconditional.

**Decision: change is in `invoke()`, not in `runCapped`'s default.**
`runCapped` is a lower-level function also callable directly from tests and potentially from future callers that legitimately want explicit control. Keeping the default `false` there and making `invoke()` always pass `true` keeps the surface clean.

**Decision: regression test uses a real subprocess, not a mock.**
The behavior under test (grandchild process being killed by a negative-PID signal) is an OS-level guarantee that cannot be meaningfully unit-tested with a fake. The test spawns a minimal shell script (`sh -c 'sleep 9999 & sleep 9999'`) so the grandchild PID is predictable; after the timeout fires, it asserts `process.kill(grandchildPid, 0)` throws ESRCH. The test is fast because the timeout is set to a small value (e.g., 0.2 s) — no wall-clock wait beyond the 5 s SIGKILL grace, which the test can lower by passing a short grace period if needed (or by accepting the 5 s).

**Decision: no changes to stages or the state machine.**
The fix is entirely in `harness.ts`. All callers of `invoke()` benefit automatically.

## Risks / Trade-offs

- *Detached child can no longer receive signals forwarded from the parent process by the OS.* This is intentional and harmless: the pipeline explicitly calls `process.kill(-pid, ...)` to reach the group; it never relies on the OS to propagate signals from the Node parent to detached children.
- *Grandchild test relies on PIDs and process-table queries.* This is inherently OS-dependent but is the only correct way to verify the invariant. The test is narrowly scoped and is unlikely to be flaky on macOS/Linux where the pipeline runs.
