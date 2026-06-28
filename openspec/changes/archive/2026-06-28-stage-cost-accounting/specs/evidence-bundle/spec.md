## ADDED Requirements

### Requirement: summary.json includes finalized stage accounting records

When `finalizeRun()` writes `summary.json`, the evidence bundle SHALL include a
top-level `accounting` object. `accounting.records` SHALL contain the run's
stage accounting records in chronological order. `accounting.totals` SHALL
contain at minimum `record_count`, `actual_cost_usd`, `estimated_cost_usd`, and
`unknown_cost_count`. The legacy `<stateDir>/<issueNumber>/evidence.json` SHALL
receive the same `accounting` object because it mirrors `summary.json`.

The accounting object is additive: existing consumers that ignore unknown fields
SHALL continue to function.

#### Scenario: Finalized summary contains accounting records and totals

- **WHEN** `finalizeRun()` writes `summary.json` after a run with two
  `stage_accounting` events
- **THEN** `summary.json.accounting.records` SHALL contain two records in
  chronological order
- **AND** `summary.json.accounting.totals.record_count` SHALL equal `2`

#### Scenario: Legacy evidence mirrors accounting object

- **WHEN** finalization writes both `summary.json` and
  `<stateDir>/<issueNumber>/evidence.json`
- **THEN** the legacy `evidence.json` SHALL contain the same `accounting`
  object as `summary.json`

#### Scenario: Unknown cost contributes to unknown count

- **WHEN** a finalized run has one accounting record with
  `cost_source: "unknown"`
- **THEN** `summary.json.accounting.totals.unknown_cost_count` SHALL include
  that record
- **AND** the unknown record SHALL NOT add `0` to `actual_cost_usd` or
  `estimated_cost_usd`

### Requirement: Public finalization comments do not include accounting payloads

The PR or issue notification comment posted at finalization SHALL NOT include
raw accounting records, usage-derived token/cost payloads, prompts, responses,
transcripts, provider payloads, or secret values. It MAY continue to include the
local bundle path as specified by the existing evidence notification contract.

#### Scenario: Finalization comment omits accounting data

- **WHEN** finalization posts a PR or issue comment for a run with accounting
  records
- **THEN** the comment SHALL NOT contain any raw accounting record JSON
- **AND** the comment SHALL NOT contain token counts, cost values, prompts,
  responses, transcripts, provider payloads, or secret values derived from usage
  logs
