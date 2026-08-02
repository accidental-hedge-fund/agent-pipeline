## ADDED Requirements

### Requirement: appendEvent durable-delivery failure SHALL update write-health and return false

`appendEvent` SHALL return `false`, log a non-fatal warning, and update the run's write-health
record as specified by the `run-store-write-health` capability when it cannot durably deliver an
event line — the local `events.jsonl` write fails and no successful exclusive-sink delivery or
exclusive-mode local fallback remains. `appendEvent` SHALL NOT throw or reject solely because of
that I/O failure. Successful durable delivery SHALL return `true` and SHALL NOT increment the
failure count.

#### Scenario: appendEvent returns false and records write-health on local I/O failure

- **WHEN** the local append to `events.jsonl` throws and no sink provides durable delivery
- **THEN** `appendEvent` SHALL return `false`
- **AND** write-health for the run SHALL reflect the failure
- **AND** `appendEvent` SHALL NOT throw

#### Scenario: Successful append returns true

- **WHEN** the local `events.jsonl` append succeeds (and sink delivery succeeds when required for
  exclusive mode)
- **THEN** `appendEvent` SHALL return `true`
- **AND** write-health failure count SHALL NOT increase

### Requirement: Readers and restart paths SHALL tolerate partial writes without misclassifying health

`readEvents` SHALL continue to tolerate a missing file (empty array), a corrupt or partial final
line (skip silently), and unknown fields (preserve). After a mid-write crash or process restart, a
consumer SHALL be able to read all complete prior lines. A write-health record that indicates
failures, or an unfinalized run whose event stream ends without `run_complete` after a recorded
write failure, SHALL be observable to status/summary consumers as degraded event-stream health and
SHALL NOT be treated as a successful complete audit trail.

#### Scenario: Partial tail line is skipped and prior events remain readable

- **WHEN** `events.jsonl` ends with a partial or unparseable final line after a mid-write failure
- **THEN** `readEvents()` SHALL return all fully parseable prior lines
- **AND** SHALL NOT throw
- **AND** SHALL NOT include the corrupt tail line

#### Scenario: Restart after append failure exposes write-health

- **WHEN** a run process records an append failure in write-health and then exits
- **AND** a subsequent process reads the same run directory
- **THEN** write-health SHALL still report the failure
- **AND** `readEvents()` SHALL return whatever complete lines were flushed before the failure

### Requirement: Optional fsync after event append SHALL not change the non-fatal contract

The engine SHALL treat optional post-append fsync (or equivalent durability flush) failure for
`events.jsonl` as a durable-delivery failure for that append: return `false`, update write-health,
and do not throw. When fsync is not enabled, the engine SHALL retain O_APPEND single-line write
semantics and SHALL document any residual durability gap relative to the durable loop store's
temp+fsync+rename document writes.

#### Scenario: fsync failure is non-fatal and visible

- **WHEN** optional post-append fsync is enabled and fsync fails after a write
- **THEN** `appendEvent` SHALL return `false`
- **AND** write-health SHALL record the failure
- **AND** `appendEvent` SHALL NOT throw

#### Scenario: Without fsync the non-fatal append contract remains

- **WHEN** optional fsync is not enabled
- **THEN** successful `appendFile` of a complete newline-terminated JSON line SHALL still return
  `true`
- **AND** I/O failures SHALL remain non-fatal with write-health recording
