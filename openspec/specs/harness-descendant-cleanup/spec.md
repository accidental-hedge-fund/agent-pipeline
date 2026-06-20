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

