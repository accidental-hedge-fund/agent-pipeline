## MODIFIED Requirements

### Requirement: Sink mode selects additive or exclusive local logging

The pipeline SHALL use the `event_sink.mode` setting to control whether run events are written to
the local `events.jsonl` in addition to the sink, or delivered to the sink alone on the happy path.
In `additive` mode (the default) each event SHALL be written to `events.jsonl` **and** delivered to
the sink. In `exclusive` mode, when sink delivery **succeeds**, the event SHALL be delivered to the
sink and SHALL NOT be written to the local `events.jsonl`. When sink delivery **fails** in
`exclusive` mode, the engine SHALL attempt a local `events.jsonl` write for that same event line
(local fallback) and SHALL record the sink failure in write-health. Mode selection SHALL affect only
the `events.jsonl` event stream on the success path; `run.json`, `terminal.log`, and `summary.json`
SHALL be written as they are today regardless of mode.

#### Scenario: additive mode writes both destinations

- **WHEN** the sink `mode` is `additive` and an event is appended
- **THEN** the event SHALL be written to the local `events.jsonl`
- **AND** the same line SHALL be delivered to the sink

#### Scenario: exclusive mode writes the sink only on success

- **WHEN** the sink `mode` is `exclusive` and sink delivery succeeds for an event
- **THEN** the event SHALL be delivered to the sink
- **AND** the event SHALL NOT be written to the local `events.jsonl`

#### Scenario: exclusive mode falls back to local write when sink delivery fails

- **WHEN** the sink `mode` is `exclusive` and sink delivery fails for an event
- **THEN** the engine SHALL attempt to write that same event line to the local `events.jsonl`
- **AND** write-health SHALL record the sink delivery failure
- **AND** when the local fallback write succeeds, durable delivery for that event SHALL be
  considered successful for the `appendEvent` return value

#### Scenario: mode does not affect other run artifacts

- **WHEN** the sink `mode` is `exclusive`
- **THEN** `run.json`, `terminal.log`, and `summary.json` SHALL still be written to the run
  directory as they are without a sink

### Requirement: Sink delivery failures are non-fatal

The pipeline run SHALL continue when delivery to a configured sink fails — the destination is
unreachable, the forwarder command errors, or it exits non-zero — and the failure SHALL be surfaced
as a non-fatal warning **and** recorded in the run's write-health, consistent with the run-store's
best-effort handling of local I/O errors. A sink failure SHALL NOT throw out of `appendEvent`, abort
the run, or block subsequent events. In `additive` mode a sink failure SHALL NOT affect the local
`events.jsonl` write, which SHALL still succeed independently. In `exclusive` mode a sink failure
SHALL trigger the local `events.jsonl` fallback described by the sink-mode requirement; if both sink
delivery and local fallback fail, `appendEvent` SHALL return `false` and write-health SHALL reflect
the dual failure.

#### Scenario: unreachable sink does not abort the run

- **WHEN** an active sink is unreachable or its forwarder command exits non-zero during an event
  delivery
- **THEN** the pipeline run SHALL continue to completion
- **AND** the failure SHALL be logged as a non-fatal warning
- **AND** write-health SHALL record the sink failure

#### Scenario: sink failure does not corrupt the local write in additive mode

- **WHEN** the sink `mode` is `additive` and sink delivery fails for an event
- **THEN** that event SHALL still be written to the local `events.jsonl`
- **AND** subsequent events SHALL continue to be appended and delivered

#### Scenario: sink failure does not propagate out of appendEvent

- **WHEN** sink delivery throws or rejects
- **THEN** `appendEvent` SHALL NOT reject or throw as a result of the sink failure

#### Scenario: exclusive dual failure returns false

- **WHEN** the sink `mode` is `exclusive` and both sink delivery and local fallback write fail
- **THEN** `appendEvent` SHALL return `false`
- **AND** write-health SHALL record the failure
- **AND** `appendEvent` SHALL NOT throw

## ADDED Requirements

### Requirement: Operators SHALL be informed of exclusive-sink durability risk and local fallback

Operator-facing documentation and config description for `event_sink.mode` SHALL state that
`exclusive` mode omits the local `events.jsonl` write while the sink is healthy, that a sink failure
can therefore lose remote audit unless fallback succeeds, and that the engine attempts a local
`events.jsonl` write when exclusive sink delivery fails. The config schema help text and generated
config reference (when present) SHALL carry this risk and fallback note so operators do not assume
dual durability in exclusive mode.

#### Scenario: Config description documents exclusive risk and fallback

- **WHEN** an operator reads the `event_sink.mode` description in pipeline config help or the
  generated config reference
- **THEN** the text SHALL state that exclusive mode skips local `events.jsonl` on successful sink
  delivery
- **AND** SHALL state that a failed exclusive delivery triggers a local write fallback and
  write-health recording
