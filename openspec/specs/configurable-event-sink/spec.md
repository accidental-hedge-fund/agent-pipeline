# configurable-event-sink Specification

## Purpose
TBD - created by archiving change configurable-event-log-sink. Update Purpose after archive.
## Requirements
### Requirement: Operators configure an external event sink via config or environment
The pipeline SHALL accept an optional `event_sink` block in `.github/pipeline.yml` that names an operator-controlled destination for run events, and SHALL accept equivalent environment-variable overrides, so that an external log destination can be configured without any code change or engine patch. The `event_sink` block SHALL be a strict schema object with `command` (string — the operator's forwarder command that receives event lines) and `mode` (one of `additive` or `exclusive`, defaulting to `additive`). The environment variables `PIPELINE_EVENT_SINK_COMMAND` and `PIPELINE_EVENT_SINK_MODE` SHALL override the corresponding file values when set. When neither the file block nor the environment supplies a `command`, no sink SHALL be active.

#### Scenario: sink configured in pipeline.yml
- **WHEN** `.github/pipeline.yml` sets `event_sink.command` to an operator-supplied forwarder command
- **THEN** `resolveConfig()` SHALL resolve an `event_sink` with that command and a `mode` of `additive` when `mode` is unset
- **AND** no code change or engine patch SHALL be required to activate it

#### Scenario: sink configured via environment variable
- **WHEN** `PIPELINE_EVENT_SINK_COMMAND` is set in the environment and `.github/pipeline.yml` has no `event_sink.command`
- **THEN** the resolved config SHALL use the environment-supplied command as the active sink command

#### Scenario: environment overrides file config
- **WHEN** `.github/pipeline.yml` sets `event_sink.command` and `PIPELINE_EVENT_SINK_COMMAND` is also set
- **THEN** the resolved sink command SHALL be the environment value, consistent with the pipeline's override-over-file precedence

#### Scenario: no sink configured
- **WHEN** neither `.github/pipeline.yml` nor the environment supplies `event_sink.command`
- **THEN** the resolved config SHALL have no active event sink

#### Scenario: invalid sink config fails fast
- **WHEN** `.github/pipeline.yml` sets `event_sink.mode` to a value outside `additive`/`exclusive`, or sets an unknown key inside `event_sink`
- **THEN** `resolveConfig()` SHALL throw a schema error identifying the offending field rather than silently using a wrong value

---

### Requirement: A configured sink receives every event as the same JSON line
When an event sink is active, each event that the run appends to `events.jsonl` SHALL also be delivered to the sink as the identical newline-terminated JSON line. Delivery SHALL cover all event producers that flow through `appendEvent` (stage lifecycle, `run_start`/`run_complete`, `pr_created`/`pr_updated`, `worktree_created`/`worktree_removed`, `review_verdict`, `blocker_set`/`blocker_cleared`, `gh_metrics_summary`, `stage_accounting`, `human_intervention`, and `papercut`). The delivered records SHALL be the same structured records currently written to `events.jsonl` — screened by the write-time injection denylist and secret redaction before delivery — with no new fields and no change to `schema_version` (which SHALL remain `1`). Delivery SHALL preserve the order in which events are appended.

#### Scenario: every appended event reaches the sink
- **WHEN** an event sink is active and a stage lifecycle, `review_verdict`, or `stage_accounting` event is appended
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`

#### Scenario: papercut events reach the sink like any other event
- **WHEN** an event sink is active and a `papercut` event is appended for a run
- **THEN** the sink SHALL receive the same JSON line that is written to `events.jsonl`, on identical terms to `blocker_set` and `human_intervention`

#### Scenario: delivered line is byte-identical to the events.jsonl line
- **WHEN** an event is delivered to the sink
- **THEN** the delivered content SHALL be identical to the line written to `events.jsonl` for that same event
- **AND** it SHALL already be screened by the injection denylist and secret redaction

#### Scenario: no schema change for the sink
- **WHEN** events are delivered to a sink
- **THEN** the events SHALL carry no additional fields introduced for sink delivery
- **AND** `schema_version` SHALL remain `1`

#### Scenario: delivery preserves append order
- **WHEN** multiple events are appended in sequence with an active sink
- **THEN** the sink SHALL receive them in the same order they are appended to `events.jsonl`

### Requirement: Sink mode selects additive or exclusive local logging
The `event_sink.mode` setting SHALL control whether run events are written to the local `events.jsonl` in addition to the sink, or delivered to the sink alone. In `additive` mode (the default) each event SHALL be written to `events.jsonl` **and** delivered to the sink. In `exclusive` mode each event SHALL be delivered to the sink and SHALL NOT be written to `events.jsonl`. Mode selection SHALL affect only the `events.jsonl` event stream; `run.json`, `terminal.log`, and `summary.json` SHALL be written as they are today regardless of mode.

#### Scenario: additive mode writes both destinations
- **WHEN** the sink `mode` is `additive` and an event is appended
- **THEN** the event SHALL be written to the local `events.jsonl`
- **AND** the same line SHALL be delivered to the sink

#### Scenario: exclusive mode writes the sink only
- **WHEN** the sink `mode` is `exclusive` and an event is appended
- **THEN** the event SHALL be delivered to the sink
- **AND** the event SHALL NOT be written to the local `events.jsonl`

#### Scenario: mode does not affect other run artifacts
- **WHEN** the sink `mode` is `exclusive`
- **THEN** `run.json`, `terminal.log`, and `summary.json` SHALL still be written to the run directory as they are without a sink

---

### Requirement: Sink delivery failures are non-fatal
When delivery to a configured sink fails — the destination is unreachable, the forwarder command errors, or it exits non-zero — the pipeline run SHALL continue and the failure SHALL be surfaced as a non-fatal warning, consistent with the run-store's existing best-effort handling of local I/O errors. A sink failure SHALL NOT throw out of `appendEvent`, abort the run, or block subsequent events. In `additive` mode a sink failure SHALL NOT affect the local `events.jsonl` write, which SHALL still succeed independently.

#### Scenario: unreachable sink does not abort the run
- **WHEN** an active sink is unreachable or its forwarder command exits non-zero during an event delivery
- **THEN** the pipeline run SHALL continue to completion
- **AND** the failure SHALL be logged as a non-fatal warning

#### Scenario: sink failure does not corrupt the local write in additive mode
- **WHEN** the sink `mode` is `additive` and sink delivery fails for an event
- **THEN** that event SHALL still be written to the local `events.jsonl`
- **AND** subsequent events SHALL continue to be appended and delivered

#### Scenario: sink failure does not propagate out of appendEvent
- **WHEN** sink delivery throws or rejects
- **THEN** `appendEvent` SHALL NOT reject or throw as a result of the sink failure

---

### Requirement: Unconfigured pipeline retains current local-file behavior exactly
When no event sink is configured, the pipeline SHALL exhibit the current local-file behavior unchanged: `events.jsonl` content, `--json-events` stdout streaming, and the `pipeline logs <run-id> --events` reader SHALL all behave byte-for-byte as they do today. Adopting this feature SHALL be strictly opt-in.

#### Scenario: events.jsonl unchanged without a sink
- **WHEN** no `event_sink` is configured and events are appended
- **THEN** the `events.jsonl` content SHALL be identical to the pre-change behavior

#### Scenario: --json-events streaming unchanged without a sink
- **WHEN** no `event_sink` is configured and the pipeline runs with `--json-events`
- **THEN** stdout event streaming SHALL be identical to the pre-change behavior

#### Scenario: logs --events reads the local file regardless of sink config
- **WHEN** `pipeline logs <run-id> --events` is invoked and the run's `events.jsonl` is present
- **THEN** the command SHALL read and print the local `events.jsonl` as it does today, regardless of whether a sink is configured

#### Scenario: exclusive mode has no local events file to read
- **WHEN** the sink `mode` is `exclusive` and `pipeline logs <run-id> --events` is invoked
- **THEN** the command SHALL behave as it does for any absent `events.jsonl` (reporting the selected file name), because exclusive mode does not write the local file

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

