## ADDED Requirements

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
