## ADDED Requirements

### Requirement: Factory scoreboard summarizes stage accounting records by routing dimensions

The `pipeline scoreboard` command SHALL aggregate stage accounting records from
included runs. It SHALL read `summary.json.accounting.records` when available
and SHALL fall back to `stage_accounting` events from `events.jsonl` when the
summary is absent or corrupt. The report SHALL group accounting data by issue,
stage, harness, model slot/model identifier, and outcome.

Each group SHALL expose at minimum: invocation count, total duration
milliseconds, command count, subprocess count, actual cost USD, estimated cost
USD, and unknown cost count. Unknown costs SHALL be reported explicitly and
SHALL NOT be counted as zero-cost invocations.

#### Scenario: JSON output contains grouped accounting totals

- **WHEN** `pipeline scoreboard --json` includes a run with stage accounting
  records
- **THEN** the parsed JSON output SHALL contain cost/accounting groups by issue,
  stage, harness, model slot/model identifier, and outcome
- **AND** each group SHALL include invocation count, duration, command count,
  subprocess count, actual cost USD, estimated cost USD, and unknown cost count

#### Scenario: Human output distinguishes cost sources

- **WHEN** `pipeline scoreboard` includes accounting records with
  `cost_source` values `actual`, `estimated`, and `unknown`
- **THEN** the human-readable report SHALL include a cost/accounting section
- **AND** that section SHALL distinguish actual cost, estimated cost, and
  unknown-cost invocation counts

#### Scenario: Missing summary falls back to accounting events

- **WHEN** an included run has a missing or corrupt `summary.json`
- **AND** the run's `events.jsonl` contains parseable `stage_accounting` events
- **THEN** the scoreboard SHALL aggregate the accounting data from
  `events.jsonl`
- **AND** it SHALL report a diagnostic for the missing or corrupt summary
  without dropping the accounting event data

#### Scenario: Unknown costs are not treated as free

- **WHEN** an included accounting record has `cost_source: "unknown"` and
  `cost_usd: null`
- **THEN** the relevant scoreboard accounting group SHALL increment unknown
  cost count
- **AND** actual and estimated cost totals SHALL remain unchanged for that
  record
