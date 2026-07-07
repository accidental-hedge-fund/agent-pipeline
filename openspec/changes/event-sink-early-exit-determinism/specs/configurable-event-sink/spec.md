## ADDED Requirements

### Requirement: Default delivery outcome is deterministic for an early-exiting forwarder

The default forwarder delivery (`defaultDeliver`) SHALL settle its delivery promise from the child process's **exit code**, not from whichever of the stdin-error and process-close events fires first. When the forwarder command exits before consuming the event line on stdin, the parent's write to stdin MAY raise an asynchronous `EPIPE` stream error; this `EPIPE` SHALL NOT settle the delivery promise. Instead the delivery SHALL mark the stdin pipe dead (and stop writing to it) and SHALL settle when the child closes: it SHALL reject with the close-shaped `event sink command exited <code>` message (including the redacted, capped stderr excerpt when present) for a non-zero exit, and SHALL resolve for a zero exit. This makes the settled outcome independent of the timing race between stdin `EPIPE` and process `close` under CPU contention.

#### Scenario: EPIPE before close settles from the exit code, not the pipe error

- **WHEN** a forwarder ignores stdin and exits non-zero, and the parent's stdin write raises an asynchronous `EPIPE` before the child's `close` event fires
- **THEN** the delivery promise SHALL reject with the close-shaped `event sink command exited <code>` message (with the redacted stderr excerpt when the forwarder wrote to stderr)
- **AND** it SHALL NOT reject with the stdin `write EPIPE` error

#### Scenario: EPIPE before a zero exit resolves

- **WHEN** a forwarder ignores stdin and exits zero, and the parent's stdin write raises an asynchronous `EPIPE` before the child's `close` event fires
- **THEN** the delivery promise SHALL resolve

#### Scenario: non-EPIPE stdin error still rejects immediately

- **WHEN** the child's stdin emits an `error` that is not an `EPIPE`
- **THEN** the delivery promise SHALL reject with that error, unchanged from prior behavior

#### Scenario: early-exiting forwarder never raises an uncaught exception

- **WHEN** a forwarder exits (zero or non-zero) without consuming a large event line, so the stdin write races the child exit
- **THEN** delivery SHALL settle the promise through resolve or reject
- **AND** no uncaught exception SHALL escape delivery, preserving the #343 EPIPE regression guarantee
