## ADDED Requirements

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
