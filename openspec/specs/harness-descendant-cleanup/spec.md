# harness-descendant-cleanup Specification

## Purpose
TBD - created by archiving change kill-harness-descendants-on-timeout. Update Purpose after archive.
## Requirements
### Requirement: Harness invocations SHALL kill the full descendant process tree on timeout

The `invoke()` function in `harness.ts` SHALL pass `killProcessGroup: true` to `runCapped` for every harness type (`claude`, `codex`, and custom reviewer CLIs). This causes `runCapped` to spawn the harness child in a new process group (`detached: true`) and, on timeout, signal the entire process group (negative PID) rather than only the direct child process, ensuring that grandchild and deeper descendant processes are also terminated.

#### Scenario: Grandchild process is killed when harness times out

- **WHEN** a harness invocation spawns a child that itself spawns a grandchild sleeping beyond the configured timeout
- **AND** the pipeline timeout fires
- **THEN** `runCapped` SHALL send SIGTERM to the entire process group
- **AND** after the 5-second grace period, SHALL send SIGKILL to the process group
- **AND** both the direct child and all grandchild processes SHALL be absent (no longer in the OS process table) after the kill sequence completes
- **AND** the returned `HarnessResult.timed_out` SHALL be `true`

#### Scenario: Normal (non-timeout) harness exit is unaffected

- **WHEN** a harness invocation exits before the timeout fires
- **THEN** the timeout timer SHALL be cleared
- **AND** `runCapped` SHALL return the child's exit code, stdout, stderr, and `timed_out: false` unchanged from prior behavior
- **AND** no process-group signal SHALL be sent

#### Scenario: Captured output accumulated before timeout is preserved

- **WHEN** a harness invocation writes output to stdout/stderr before the timeout fires
- **AND** the timeout subsequently fires and kills the process group
- **THEN** the returned `HarnessResult.stdout` and `HarnessResult.stderr` SHALL contain the output accumulated up to the moment of termination
- **AND** SHALL NOT be empty or discarded due to the process-group kill

### Requirement: Process-group kill is applied unconditionally to all harness types

The `invoke()` function SHALL NOT gate `killProcessGroup` on the harness type or any configuration flag. Process-group creation (detached spawning) is inert for normal exits and costs nothing, so the safe default is always-on.

#### Scenario: `claude` harness uses process-group kill

- **WHEN** `invoke("claude", ...)` is called
- **THEN** the underlying `runCapped` call SHALL receive `{ killProcessGroup: true }`
- **AND** the claude process SHALL be spawned with `detached: true`

#### Scenario: `codex` harness uses process-group kill

- **WHEN** `invoke("codex", ...)` is called
- **THEN** the underlying `runCapped` call SHALL receive `{ killProcessGroup: true }`
- **AND** the codex process SHALL be spawned with `detached: true`

#### Scenario: Custom reviewer CLI uses process-group kill

- **WHEN** `invoke("<custom-cli>", ...)` is called for a configured reviewer CLI
- **THEN** the underlying `runCapped` call SHALL receive `{ killProcessGroup: true }`
- **AND** the custom CLI process SHALL be spawned with `detached: true`

### Requirement: Regression test SHALL assert grandchild termination after timeout

The test suite SHALL include at least one test for the descendant-cleanup behavior that:
1. Spawns a real child process that itself forks a grandchild sleeping well beyond the test timeout.
2. Lets the `runCapped` timeout fire.
3. Asserts that neither the child nor the grandchild PID is present in the OS process table afterward.

#### Scenario: Regression test confirms no orphaned grandchild

- **WHEN** the test invokes `runCapped` with a script that forks a long-sleeping grandchild and a short timeout
- **THEN** after `runCapped` resolves, `process.kill(grandchildPid, 0)` SHALL throw (ESRCH — process does not exist)
- **AND** the returned `HarnessResult.timed_out` SHALL be `true`

### Requirement: runCapped SHALL resolve unconditionally within a bounded secondary deadline after a timeout

`runCapped` SHALL guarantee that once the wall-clock cap fires, its returned promise settles with `timed_out: true` within a hard secondary deadline, independent of whether the child's stdout/stderr streams ever emit `close` and independent of whether the process-group kill succeeds. The secondary deadline SHALL be armed as a sibling timer at the moment the cap fires (not nested inside the SIGTERM→SIGKILL escalation chain), default to `killGraceSec + 30` seconds, and be overridable via an injectable option so tests can use a short value. The existing SIGTERM → grace → SIGKILL escalation SHALL be retained so a cleanly-killed child still resolves at its current latency; the secondary deadline is a failsafe that only settles when nothing else has, and `runCapped`'s single-settle idempotence SHALL make it a no-op when the child or the escalation chain already resolved.

#### Scenario: Child streams never close after kill — promise still resolves as timed_out

- **WHEN** `runCapped` is called with an injected spawn seam whose child never emits `close`/`end` on stdout or stderr
- **AND** the process-group kill is a no-op (the detached tree survives the kill)
- **AND** the wall-clock cap fires
- **THEN** the returned promise SHALL settle within the hard secondary deadline
- **AND** the resolved `HarnessResult.timed_out` SHALL be `true`
- **AND** the promise SHALL NOT remain pending indefinitely

#### Scenario: Resolution is independent of the SIGKILL escalation completing

- **WHEN** the wall-clock cap fires and the `killGroup` implementation does nothing (stubbed no-op)
- **THEN** `runCapped` SHALL still resolve `timed_out: true` within the secondary deadline
- **AND** resolution SHALL NOT depend on the SIGTERM→grace→SIGKILL chain running to completion

#### Scenario: Clean timeout resolves via the escalation path with no added latency

- **WHEN** the wall-clock cap fires and the child process group dies on SIGTERM or SIGKILL and closes its streams
- **THEN** `runCapped` SHALL resolve from the existing escalation path with `timed_out: true`
- **AND** the secondary-deadline failsafe SHALL NOT fire (it is a no-op once the escalation path has settled)
- **AND** the resolved `HarnessResult` shape SHALL be identical to today's timeout result

#### Scenario: Non-timeout exit is unaffected by the secondary deadline

- **WHEN** a harness invocation exits normally before the wall-clock cap fires
- **THEN** the wall-clock cap timer SHALL be cleared and the secondary deadline SHALL never be armed
- **AND** `runCapped` SHALL resolve with the child's exit code, stdout, stderr, and `timed_out: false` unchanged from prior behavior

### Requirement: The secondary-deadline resolution SHALL be covered by a regression test using the injected spawn seam

The test suite SHALL include a regression test that exercises the bounded-resolution guarantee without a real subprocess: it SHALL inject a `spawnFn` producing a fake child whose stdout/stderr never emit `close` and whose group kill is a no-op, drive `runCapped` past a short wall-clock cap, and assert the promise resolves `timed_out: true` within the secondary window. The test SHALL demonstrably bite — without the failsafe timer it SHALL hang or fail rather than pass.

#### Scenario: Regression test asserts resolution instead of an indefinite pend

- **WHEN** the test injects a fake child whose streams never close and a no-op group kill, with short `timeoutSec`, `killGraceSec`, and secondary-deadline values
- **THEN** `runCapped` SHALL resolve within the secondary window
- **AND** the resolved `HarnessResult.timed_out` SHALL be `true`
- **AND** the test SHALL fail (hang/timeout) if the failsafe timer is removed

