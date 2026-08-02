# run-store-write-health Specification

## Purpose
TBD - created by archiving change run-store-event-append-visibility. Update Purpose after archive.
## Requirements
### Requirement: The run store SHALL persist event-stream write-health for each run

The run store SHALL maintain a durable, run-scoped write-health record for the event stream of each
run directory under `.agent-pipeline/runs/<run-id>/`. When an `appendEvent` durable delivery fails
(local `events.jsonl` write failure, exclusive-sink delivery failure with no successful local
fallback, or both), the run store SHALL update that write-health record without throwing out of
`appendEvent`. The record SHALL include at minimum: a failure count, the ISO 8601 timestamp of the
most recent failure, a capped redacted last error message, the last failed event `type` when known,
the worst criticality among failed writes (`control-critical` or `best-effort`), and whether an
exclusive-sink local fallback was attempted and whether it succeeded. A run with no recorded
failures SHALL present as healthy (empty or zero-failure write-health). Write-health update I/O
failures SHALL themselves be best-effort and SHALL NOT throw out of `appendEvent`.

#### Scenario: Local append failure records write-health

- **WHEN** `appendEvent` fails to write a line to local `events.jsonl` and durable delivery does not
  succeed by another path
- **THEN** the run's write-health record SHALL reflect a failure
- **AND** `appendEvent` SHALL return `false`
- **AND** `appendEvent` SHALL NOT throw

#### Scenario: Healthy run has no elevated write-health

- **WHEN** every `appendEvent` for a run succeeds durable delivery
- **THEN** write-health for that run SHALL report zero failures (or equivalent healthy state)
- **AND** operator surfaces SHALL NOT warn about event-stream write failure for that run

#### Scenario: Write-health survives process restart

- **WHEN** a run recorded at least one append failure and the process exits
- **AND** a later status, summary, doctor, or recovery consumer opens the same run directory
- **THEN** that consumer SHALL observe the persisted write-health failure state without relying on
  in-memory process state

#### Scenario: Unreadable or corrupt write-health is elevated fail-safe

- **WHEN** `write-health.json` exists but is unreadable, partially written, or not a valid
  write-health record
- **THEN** readers SHALL NOT treat the run as healthy or zero-failure
- **AND** SHALL expose an elevated write-health state with control-critical worst criticality
- **AND** operator surfaces (status, summary, doctor) and recovery classification SHALL observe
  that elevated state
- **AND** a missing write-health file (legacy / never written) SHALL remain non-elevated

### Requirement: Event appends SHALL carry a criticality class

Every `appendEvent` invocation SHALL be classified as either `control-critical` or `best-effort`.
Control-critical classification SHALL apply to records that recovery or authority disposition depends
on, including at least: `blocker_set`, `blocker_cleared`, stage-diagnostic evidence used as recovery
input, recovery claim and result events, and run/loop terminal state events routed through
`appendEvent` (including `run_complete`). Other event types SHALL default to `best-effort` unless a
caller explicitly elevates them. Best-effort append failure SHALL NOT block stage advancement or
change pipeline stage labels. Control-critical append failure SHALL update write-health with
`control-critical` worst criticality and SHALL remain non-throwing for stage I/O, while remaining
operator-visible through write-health surfaces.

#### Scenario: Best-effort failure does not block the stage

- **WHEN** a best-effort telemetry event fails to append durably
- **THEN** the stage handler's advancement decision SHALL proceed based on labels and stage outcome
  as today
- **AND** write-health SHALL record the failure with best-effort criticality when it is the worst
  class observed

#### Scenario: Control-critical failure elevates write-health

- **WHEN** a control-critical event (for example `blocker_set`) fails to append durably
- **THEN** write-health SHALL record the failure
- **AND** the worst criticality on the record SHALL be `control-critical`
- **AND** `appendEvent` SHALL return `false` without throwing

### Requirement: Status, doctor, and summary SHALL surface write-health failures

Operator-facing `status`, `doctor`, and `summary` surfaces SHALL report a run's elevated event-stream
write-health when present. Status prose SHALL include a human-readable warning. Machine-readable
status JSON SHALL include an additive write-health field (or equivalent object) without changing
`schema_version` from `"1"`. Summary output and finalized `summary.json` SHALL include write-health
so a completed run cannot hide truncated or empty evidence. Doctor SHALL include a deterministic
check that fails with remediation text when the run-store write path is not writable or when a
bounded recent set of runs shows elevated write-health failures; a failing check SHALL contribute to
doctor's non-zero exit.

#### Scenario: Status JSON exposes write-health after mid-run append failure

- **WHEN** the latest run for an issue has a write-health failure recorded
- **AND** `pipeline <issue> --status --json` is invoked
- **THEN** the JSON envelope SHALL include an additive field describing event-stream write-health
  failure
- **AND** `schema_version` SHALL remain `"1"`

#### Scenario: Status prose warns on write-health failure

- **WHEN** the latest run for an issue has a write-health failure recorded
- **AND** `pipeline <issue> --status` is invoked without `--json`
- **THEN** the prose output SHALL include a warning that the event stream experienced write failure

#### Scenario: Summary includes write-health

- **WHEN** `finalizeRun` writes `summary.json` for a run that recorded append failures
- **THEN** `summary.json` SHALL include the write-health failure state
- **AND** `pipeline summary` for that issue or run-id SHALL surface the same failure to the operator

#### Scenario: Doctor fails on elevated recent write-health

- **WHEN** `pipeline doctor` runs and a bounded recent scan finds a run with elevated write-health
  failures, or the run-store parent path is not writable
- **THEN** the corresponding doctor check SHALL fail
- **AND** remediation text SHALL instruct the operator how to investigate disk, permissions, or the
  event sink
- **AND** doctor SHALL exit non-zero when any check fails

