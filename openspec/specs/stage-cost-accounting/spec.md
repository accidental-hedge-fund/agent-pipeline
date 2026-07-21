# stage-cost-accounting Specification

## Purpose
TBD - created by archiving change stage-cost-accounting. Update Purpose after archive.
## Requirements
### Requirement: Stage accounting records capture routing-relevant cost dimensions

The pipeline SHALL represent each accounted harness or subprocess invocation as
a stage accounting record. Each record SHALL contain `schema_version`, `run_id`,
`issue`, `stage`, `harness`, `model_slot`, `model`, `started_at`, `ended_at` or
`duration_ms`, `command_count`, `subprocess_count`, `outcome`,
`blocker_kind`, `cost_source`, and `cost_usd`. `cost_source` SHALL be one of
`actual`, `estimated`, or `unknown`. `cost_usd` SHALL be a non-negative number
only when `cost_source` is `actual` or `estimated`; it SHALL be `null` when
`cost_source` is `unknown`.

The accounting record MAY include a `usage` object containing sanitized numeric
token counters, such as `input_tokens`, `output_tokens`, and `total_tokens`,
when those values are available. Missing token counters SHALL be omitted or
`null`; they SHALL NOT be written as zero unless the provider explicitly reports
zero.

#### Scenario: Harness invocation creates an accounting record

- **WHEN** a stage invokes a harness and the invocation returns
- **THEN** the pipeline SHALL create one stage accounting record for that
  invocation
- **AND** the record SHALL contain the invoking stage, harness, model slot/model
  identifier, duration, command/subprocess counts, outcome, and cost source

#### Scenario: Missing actual cost is unknown rather than zero

- **WHEN** a harness invocation completes without actual cost data and no
  explicit estimate is available
- **THEN** the accounting record SHALL contain `cost_source: "unknown"`
- **AND** the accounting record SHALL contain `cost_usd: null`
- **AND** the accounting record SHALL NOT contain `cost_usd: 0`

#### Scenario: Explicit estimate is distinguishable from actual cost

- **WHEN** a harness invocation has no actual cost data but an explicit
  deterministic estimate is applied
- **THEN** the accounting record SHALL contain `cost_source: "estimated"`
- **AND** `cost_usd` SHALL contain the estimated non-negative USD value
- **AND** consumers SHALL be able to distinguish this value from
  `cost_source: "actual"`

### Requirement: Actual usage ingestion is allowlist-only and sanitized

The pipeline SHALL use allowlist-only extraction when deriving accounting data
from provider output or local usage logs. It SHALL persist only allowlisted
accounting fields: numeric token counts, numeric cost, harness name, model
slot/model identifier, and timestamps or durations. The pipeline SHALL NOT
persist raw prompts, responses, transcripts,
provider request/response payloads, local usage-log lines, local usage-log
paths, provider request identifiers, raw environment values, or secrets in any
accounting record, event, summary, legacy evidence bundle, or public issue/PR
comment.

All persisted accounting string fields SHALL pass through the existing artifact
secret-redaction and injection-denylist process before being written.

#### Scenario: Usage log with prompt text persists only accounting fields

- **WHEN** a local usage log contains token counts, cost, model identifier, and
  raw prompt/response text for the same invocation
- **THEN** the accounting record SHALL include the numeric usage and model
  accounting fields
- **AND** the accounting record SHALL NOT include the raw prompt or response text

#### Scenario: Usage log secret is not persisted

- **WHEN** usage-derived data contains a raw token, API key, or environment
  variable value
- **THEN** no persisted accounting artifact or public issue/PR comment SHALL
  contain the raw secret value
- **AND** any persisted string field derived from that data SHALL contain the
  redacted placeholder instead of the raw value

### Requirement: Accounting data is observational and does not affect routing

The pipeline SHALL NOT use stage accounting records to choose the current stage,
next stage, review harness, model slot, blocker disposition, or merge behavior
as part of this change. The authoritative routing and state-machine inputs SHALL
remain the existing labels, comments, configuration, review verdicts, and gate
results.

#### Scenario: Accounting records do not change stage advancement

- **WHEN** two otherwise identical runs differ only in their recorded accounting
  cost values
- **THEN** the stage transition decisions SHALL be identical for both runs
- **AND** no label transition SHALL depend on the accounting cost values

#### Scenario: Accounting event emission failure is non-fatal

- **WHEN** an accounting event emission to `events.jsonl` fails
- **THEN** the stage SHALL continue according to the existing run-artifact
  non-fatal write convention
- **AND** the pipeline SHALL NOT enter a blocked or error state solely because
  accounting event emission fails

#### Scenario: Absent accounting instrumentation does not block a stage

- **WHEN** accounting instrumentation is not wired for a stage invocation
- **THEN** the stage SHALL complete normally without producing an accounting record
- **AND** no accounting record SHALL be required for the stage to produce its outcome

### Requirement: Stage accounting records sanitized prompt size

For every harness invocation that emits a stage accounting record, the pipeline SHALL record numeric prompt-size telemetry when the prompt string is available. The record SHALL include `prompt_chars` and `prompt_estimated_tokens` as non-negative integers. The pipeline SHALL NOT persist raw prompt text, prompt excerpts, prompt hashes that can be used as content identifiers, responses, transcripts, local usage-log paths, or secrets as part of this telemetry.

#### Scenario: Harness invocation records prompt size
- **WHEN** a harness invocation receives a prompt and emits a `stage_accounting` event
- **THEN** the event SHALL include `prompt_chars` equal to the prompt length
- **AND** `prompt_estimated_tokens` SHALL be a non-negative estimate derived from prompt length

#### Scenario: Prompt content remains absent
- **WHEN** the prompt contains issue text, code, or secret-looking strings
- **THEN** no persisted accounting artifact SHALL contain the raw prompt text or an excerpt of it
- **AND** the persisted prompt telemetry SHALL be limited to numeric size fields

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

### Requirement: Stage accounting records capture the resolved reasoning effort

A stage accounting record SHALL include an optional `effort` field carrying the reasoning
effort that was actually resolved for that invocation — the value the pipeline passed to
the harness as `--effort` or `model_reasoning_effort` — so that the effort dimension is a
recorded identity rather than a value inferred at report time.

The field SHALL be additive and optional: it SHALL be written when an effort was resolved
for the invocation, SHALL be omitted or `null` when none was, and SHALL NOT be written as
a fabricated default. Adding it SHALL NOT add or remove any required field, and readers
SHALL continue to accept records written before this field existed. The effort value
SHALL NOT be reconstructed from the current configuration when reading historical
records, because the configuration may have changed since those records were written.

#### Scenario: A stage with a resolved effort records it

- **WHEN** a stage invokes a harness with a resolved reasoning effort
- **THEN** the resulting stage accounting record SHALL carry that effort value verbatim in
  its `effort` field

#### Scenario: A stage with no resolved effort omits the field

- **WHEN** a stage invokes a harness without any resolved reasoning effort
- **THEN** the resulting stage accounting record SHALL omit `effort` or set it to `null`
- **AND** it SHALL NOT record a substituted or default effort value

#### Scenario: Records written before the field remain readable

- **WHEN** a reader processes a stage accounting record that predates the `effort` field
- **THEN** the record SHALL parse successfully with every other field unchanged
- **AND** the reader SHALL treat the missing effort as unknown rather than as a value

