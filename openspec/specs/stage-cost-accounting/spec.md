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

