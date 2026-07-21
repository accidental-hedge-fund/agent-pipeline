# stage-cost-accounting Spec Delta

## ADDED Requirements

### Requirement: Built-in harness invocations capture per-call cost telemetry

The pipeline SHALL invoke each built-in harness (`claude`, `codex`) in a
machine-readable output mode that exposes per-call telemetry, and SHALL derive the
stage accounting record's cost and usage fields from that telemetry. When the harness
reports a numeric per-call cost, the resulting `stage_accounting` event SHALL contain
`cost_source: "actual"` and a `cost_usd` equal to the reported value. When the harness
reports token counters, the event SHALL contain them in its `usage` object.

The pipeline SHALL NOT synthesize a cost from token counters using a built-in price
table; a harness that reports tokens but no cost SHALL NOT produce
`cost_source: "actual"`.

Harnesses that expose no such telemetry — a user-configured `review_harness` CLI, an
external stage executor, or a subprocess gate command — SHALL continue to record
`cost_source: "estimated"` or `cost_source: "unknown"` exactly as before.

#### Scenario: Claude call records reported cost as actual
- **WHEN** a `claude` harness invocation with accounting enabled completes and its
  telemetry envelope reports `total_cost_usd`
- **THEN** the emitted `stage_accounting` event SHALL contain `cost_source: "actual"`
- **AND** `cost_usd` SHALL equal the reported `total_cost_usd`
- **AND** the event's `usage` object SHALL contain the reported input, output, and
  cache token counters

#### Scenario: Codex call records tokens but not an actual cost
- **WHEN** a `codex` harness invocation with accounting enabled completes and its
  telemetry reports token counters and no cost field
- **THEN** the emitted `stage_accounting` event's `usage` object SHALL contain the
  reported token counters
- **AND** `cost_source` SHALL NOT be `actual`
- **AND** `cost_source` SHALL be `estimated` when an explicit operator estimate applies,
  otherwise `unknown` with `cost_usd: null`

#### Scenario: Custom reviewer CLI is unaffected
- **WHEN** a stage invokes a user-configured `review_harness` CLI that emits no
  telemetry envelope
- **THEN** the invocation arguments SHALL remain the prompt as a single positional
  argument
- **AND** the emitted accounting record SHALL contain `cost_source: "estimated"` or
  `cost_source: "unknown"` with `cost_usd: null`

### Requirement: Telemetry capture preserves harness output and streaming

Telemetry capture SHALL be transparent to every consumer of a harness result. The
`stdout` of a telemetry-mode invocation SHALL be the harness's final assistant text, so
verdict parsing, fix rounds, and gate parsing behave identically to the previous
plain-text output mode. When streaming is enabled, the pipeline SHALL forward the
harness's assistant text to the operator's terminal as it arrives and SHALL NOT forward
raw telemetry envelope lines.

#### Scenario: Verdict parsing is unchanged
- **WHEN** a review invocation runs in telemetry mode and the harness's final assistant
  text is a verdict JSON object
- **THEN** the harness result's `stdout` SHALL be that verdict JSON text
- **AND** verdict parsing SHALL succeed exactly as it did in plain-text output mode

#### Scenario: Terminal shows assistant text, not envelope JSON
- **WHEN** a telemetry-mode invocation runs with streaming enabled
- **THEN** the forwarded terminal output SHALL contain the harness's assistant text
- **AND** it SHALL NOT contain the raw telemetry envelope lines

### Requirement: Unparseable telemetry degrades to unknown cost without failing the stage

The pipeline SHALL treat telemetry capture as observational. When the telemetry
envelope is absent, truncated, or unparseable — including timeout, kill, spawn failure,
and non-JSON output — the invocation SHALL still return its captured output and its
existing outcome classification, and the accounting record SHALL contain
`cost_source: "unknown"` and `cost_usd: null`. The pipeline SHALL NOT block, fail, or
retry a stage solely because telemetry could not be parsed.

The pipeline SHALL provide an environment kill-switch that restores the previous
plain-text invocation arguments for built-in harnesses.

#### Scenario: Truncated envelope yields unknown cost
- **WHEN** a harness invocation is killed on timeout and its captured output ends with
  an incomplete telemetry line and contains no terminal result line
- **THEN** the accounting record SHALL contain `cost_source: "unknown"` and
  `cost_usd: null`
- **AND** the invocation's outcome SHALL be classified from the exit/timeout signal
  exactly as before

#### Scenario: Non-JSON harness output does not break the call
- **WHEN** a built-in harness emits plain text that contains no parseable telemetry
  envelope
- **THEN** the harness result SHALL contain the captured output as `stdout`
- **AND** the accounting record SHALL contain `cost_source: "unknown"` and
  `cost_usd: null`
- **AND** the stage SHALL NOT enter a blocked or error state because of the missing
  telemetry

#### Scenario: Kill-switch restores plain-text invocation
- **WHEN** the telemetry kill-switch environment variable is set to the disabling value
- **THEN** built-in harness invocations SHALL use the previous plain-text output
  arguments
- **AND** emitted accounting records SHALL contain `cost_source: "estimated"` or
  `cost_source: "unknown"`, never `actual` from harness telemetry

### Requirement: Telemetry-derived accounting fields are allowlist-only

The pipeline SHALL persist from a telemetry envelope only the allowlisted accounting
fields already defined by this capability: numeric token counters, numeric cost, harness
name, model slot/model identifier, and timestamps or durations. It SHALL NOT persist the
harness session identifier, message or event identifiers, assistant or user text,
rate-limit objects, transcripts, usage-log paths, or any other envelope field into an
accounting record, event, summary, evidence bundle, or public issue/PR comment.

#### Scenario: Session and message identifiers are not persisted
- **WHEN** a telemetry envelope contains `session_id`, `uuid`, and `parent_tool_use_id`
  alongside cost and token fields
- **THEN** the emitted accounting record SHALL contain the cost and token fields
- **AND** it SHALL NOT contain the session identifier, message identifier, or parent
  tool-use identifier

#### Scenario: Assistant text is not persisted
- **WHEN** a telemetry envelope's terminal result carries the full assistant response
  text
- **THEN** no persisted accounting artifact SHALL contain that response text or an
  excerpt of it

### Requirement: Stage accounting schema version 2 is additive and backward compatible

The pipeline SHALL write newly emitted `stage_accounting` records with
`schema_version: 2`. Version 2 SHALL add no required field and remove no field relative
to version 1. Readers of accounting records SHALL accept records of any recorded schema
version and SHALL NOT reject, drop, or diagnose a record solely because its
`schema_version` differs from the current one.

#### Scenario: New records declare schema version 2
- **WHEN** a harness invocation with accounting enabled emits a `stage_accounting` event
- **THEN** the event SHALL contain `schema_version: 2`

#### Scenario: Mixed-version records aggregate together
- **WHEN** a consumer reads accounting records where some contain `schema_version: 1`
  and others contain `schema_version: 2`
- **THEN** all records SHALL contribute to the aggregated totals
- **AND** no record SHALL be excluded or reported as a diagnostic because of its
  `schema_version`
