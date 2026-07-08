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

### Requirement: runCapped SHALL resolve a spawn_error result when spawn() throws synchronously

`runCapped` SHALL guard the `spawn()` construction call (the `spawnFn`/`spawn` invocation) so that a
**synchronous** throw from `spawn()` is caught and converted into a resolved `HarnessResult` rather
than rejecting the returned promise or propagating as an unhandled exception. The synchronous throw
surface includes `node:child_process` argv validation errors — most notably a `TypeError
[ERR_INVALID_ARG_VALUE]` when an argv string contains a NUL byte (`U+0000`). The resolved result
SHALL have `success: false`, `spawn_error: true`, `exit_code: -1`, and `timed_out: false`, and its
`stderr` SHALL preserve the underlying error message. This mirrors the classification already
applied to **asynchronous** spawn failures (`child.on("error")`), so every downstream consumer
(`invoke()`, `harnessOutcome()`, `advanceReview`) handles both spawn-failure surfaces identically.
The guard SHALL be scoped to the spawn construction call only; it SHALL NOT alter the handling of a
successfully spawned child (streams, timeout escalation, secondary deadline, capture-error, or
close paths).

#### Scenario: NUL byte in harness argv resolves as spawn_error instead of crashing

- **WHEN** `runCapped` (or `invoke`) is called with argv/prompt content containing a NUL byte
  (`U+0000`) such that `spawn()` throws `ERR_INVALID_ARG_VALUE` synchronously
- **THEN** the returned promise SHALL resolve (SHALL NOT reject and SHALL NOT throw an uncaught
  exception that exits the process)
- **AND** the resolved `HarnessResult` SHALL have `success: false`, `spawn_error: true`,
  `exit_code: -1`, and `timed_out: false`
- **AND** the resolved `HarnessResult.stderr` SHALL preserve the underlying spawn error message

#### Scenario: Non-NUL synchronous spawn throw is also caught

- **WHEN** the `spawn()` construction call throws synchronously for a reason other than a NUL byte
  (e.g. a different invalid-argv error)
- **THEN** `runCapped` SHALL still resolve a `HarnessResult` with `success: false` and
  `spawn_error: true`
- **AND** the promise SHALL NOT reject or throw

#### Scenario: Asynchronous spawn failures remain unchanged

- **WHEN** `spawn()` succeeds synchronously but the child later emits an `'error'` event (ENOENT,
  missing execute permission)
- **THEN** the existing `child.on("error")` handling SHALL apply unchanged, resolving a
  `spawn_error: true` result as before
- **AND** the new synchronous guard SHALL NOT alter this behavior

### Requirement: A synchronous NUL-byte spawn failure SHALL carry an identifying, non-raw marker

`runCapped` SHALL, when the caught synchronous throw is the NUL-byte case (an
`ERR_INVALID_ARG_VALUE` whose message indicates a null byte), prepend a fixed, greppable marker
identifying the defect class — `NUL byte (U+0000) detected in harness argv payload` — to the
resolved `HarnessResult.stderr`.
`runCapped` SHALL NOT echo the raw NUL byte itself into the captured output or log stream. For a
non-NUL synchronous throw, `runCapped` SHALL NOT add the NUL marker. Because `advanceReview`
composes the blocked-state message from the harness `stderr` excerpt, this marker SHALL propagate
into the blocked-item evidence so an operator can identify the NUL-byte defect from the blocked
state alone.

#### Scenario: Blocked state identifies the NUL-byte defect

- **WHEN** a reviewer invocation resolves a `spawn_error` result due to a NUL byte in the payload
- **THEN** the resolved `HarnessResult.stderr` SHALL contain the marker `NUL byte (U+0000) detected
  in harness argv payload`
- **AND** the raw NUL byte SHALL NOT be present in the captured `stderr`
- **AND** the resulting blocked-item message (built by `advanceReview` via the stderr excerpt)
  SHALL therefore include enough detail to identify the NUL-byte defect, not a generic failure

#### Scenario: Reviewer spawn failure reaches a blocked state, not a process crash

- **WHEN** the reviewer harness is invoked for a review stage and the payload contains a NUL byte
- **THEN** `advanceReview` SHALL receive a `HarnessResult` with `success: false`
- **AND** SHALL call `setBlocked(...)` with blocker kind `"harness-failure"` and a message
  containing the NUL-byte detail
- **AND** the run SHALL reach the blocked state rather than exiting the process with an unhandled
  `ERR_INVALID_ARG_VALUE`
- **AND** the stage SHALL NOT be left mid-flight with no label change

### Requirement: The synchronous-spawn-failure resolution SHALL be covered by a regression test

The test suite SHALL include a regression test that exercises the synchronous-throw guarantee using
the injectable `spawnFn` seam and/or a real NUL-byte argv: it SHALL drive `runCapped` (or `invoke`)
with a spawn that throws synchronously (an injected `spawnFn` throwing `ERR_INVALID_ARG_VALUE`
and/or a real prompt containing `"\0"`) and assert the promise **resolves** a `spawn_error: true`
result with the NUL marker in `stderr` — never a thrown/rejected exception. The test SHALL
demonstrably bite: without the synchronous `try/catch` guard it SHALL throw or reject rather than
pass.

#### Scenario: Regression test asserts resolution instead of a thrown exception

- **WHEN** the test injects a `spawnFn` that throws a `TypeError` with `code:
  "ERR_INVALID_ARG_VALUE"` and a null-byte message (and/or calls `invoke` with a `"\0"`-containing
  prompt)
- **THEN** `runCapped`/`invoke` SHALL resolve a `HarnessResult` with `spawn_error: true` and
  `success: false`
- **AND** the resolved `stderr` SHALL contain the `NUL byte (U+0000)` marker
- **AND** the test SHALL fail (throw/reject) if the synchronous `try/catch` guard is removed

