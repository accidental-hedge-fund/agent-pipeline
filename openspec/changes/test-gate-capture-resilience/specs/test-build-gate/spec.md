## ADDED Requirements

### Requirement: Gate outcome derives solely from the observed test-command exit code

The test/build gate's pass/fail outcome SHALL be determined solely by the test command's observed
process exit code. A write failure in the run-store event sink, or in any other telemetry /
log-capture write the pipeline performs while the command runs (including a synchronous socket-write
throw such as `EPIPE`), SHALL NOT fail the gate and SHALL NOT terminate or truncate the gate's
outcome determination. Such capture/telemetry write errors SHALL be recorded as non-fatal tooling
diagnostics (logged, as `appendEvent` already does) and SHALL NOT appear as the gate's
`blockReason`. When the command exits 0, the gate SHALL report a pass even if a concurrent
event-sink or log-capture write failed.

#### Scenario: event-sink write failure during a passing run does not fail the gate

- **WHEN** the test/build command runs and exits 0
- **AND** a run-store event-sink delivery write fails (e.g. the forwarder socket returns `EPIPE`)
  while the command is running
- **THEN** the gate SHALL report `{ passed: true }`
- **AND** the sink failure SHALL be recorded as a non-fatal diagnostic
- **AND** the sink failure SHALL NOT be surfaced as the gate's `blockReason`

#### Scenario: capture/telemetry write error never becomes the block reason

- **WHEN** a telemetry or log-capture write fails during the gate but the test command's exit code
  is observed cleanly
- **THEN** the gate outcome SHALL equal the outcome implied by that exit code
- **AND** no capture/telemetry stack trace or write-error text SHALL be used as the `blockReason`

### Requirement: Abnormal output-capture termination is a bounded tooling-failure retry, not a fix attempt

The gate SHALL treat a test-command run that terminates abnormally — one where the pipeline never
observes a clean process exit code (a spawn error or a capture pipe that broke before `close`), as
opposed to a genuine non-zero exit — as a **tooling failure**, and SHALL re-run the same command up
to a bounded number of tooling retries WITHOUT invoking the fix harness. A tooling-failure retry
SHALL NOT decrement or consume the `test_gate.max_attempts` fix budget. Only a cleanly-observed
non-zero exit code SHALL be treated as a genuine test failure that enters the bounded
generate→test→fix loop. If the bounded tooling retries are exhausted without ever observing a clean
exit code, the gate SHALL block with a tooling-failure reason that is distinct from the ordinary
"test/build gate failed after N fix attempt(s)" test-failure reason.

#### Scenario: capture dies before exit observed — command is re-run, fix harness is not invoked

- **WHEN** a test-command run ends without a clean observed exit code (spawn/capture error)
- **THEN** the gate SHALL re-run the same test command
- **AND** SHALL NOT invoke the fix harness for that attempt
- **AND** SHALL NOT decrement or consume `test_gate.max_attempts`

#### Scenario: tooling-failure retry then a clean pass reports a pass with no fix charged

- **WHEN** the first run terminates abnormally (no clean exit observed)
- **AND** a bounded tooling retry then runs the command to a clean exit 0
- **THEN** the gate SHALL report `{ passed: true, attempts: 0 }`
- **AND** SHALL have performed zero fix-harness invocations

#### Scenario: cleanly-observed non-zero exit still enters the fix loop

- **WHEN** a test-command run completes with a cleanly-observed non-zero exit code
- **THEN** the gate SHALL treat it as a genuine test failure
- **AND** SHALL enter the bounded generate→test→fix loop (charging a fix attempt), NOT the
  tooling-failure retry path

#### Scenario: tooling retries exhausted blocks with a distinct tooling-failure reason

- **WHEN** every bounded tooling retry terminates abnormally without a clean observed exit code
- **THEN** the gate SHALL block
- **AND** the `blockReason` SHALL identify the failure as a tooling/capture failure
- **AND** the reason SHALL be distinct from the "test/build gate failed after N fix attempt(s)"
  test-failure message

### Requirement: Test-gate failure excerpt preserves the summary tail

The gate SHALL produce the captured-output failure excerpt used as the `blockReason` with a
tail-biased elision strategy whenever the captured test/build command output exceeds the gate's
block-output cap (`MAX_BLOCK_OUTPUT`) — keeping a leading **head** fragment (command/setup context), an explicit
middle-elision **marker** indicating how much intervening content was dropped, and a trailing
**tail** fragment (where a test runner prints its pass/fail summary) — rather than by keeping only
the leading characters. The head plus tail source characters shown SHALL together not exceed
`MAX_BLOCK_OUTPUT`. When the captured output is at or below `MAX_BLOCK_OUTPUT` characters, the
excerpt SHALL equal the output verbatim with no elision marker added. This mirrors the eval-gate
tail-biased excerpt (#373) so the decisive summary survives truncation instead of the excerpt ending
inside leading boilerplate.

#### Scenario: over-cap failure output keeps the summary tail

- **WHEN** a test-gate failure's captured output exceeds `MAX_BLOCK_OUTPUT` characters and the
  pass/fail summary is in the final characters
- **THEN** the `blockReason` excerpt SHALL contain those final summary characters
- **AND** SHALL contain a leading head fragment followed by a middle-elision marker before the tail
- **AND** the head plus tail source characters shown SHALL not exceed `MAX_BLOCK_OUTPUT`

#### Scenario: at-or-under-cap output is verbatim

- **WHEN** a test-gate failure's captured output is at or below `MAX_BLOCK_OUTPUT` characters
- **THEN** the `blockReason` excerpt SHALL equal the captured output verbatim
- **AND** SHALL NOT contain an elision marker
