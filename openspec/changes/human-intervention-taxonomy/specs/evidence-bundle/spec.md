## ADDED Requirements

### Requirement: Override records carry an optional kind field from the taxonomy
Each `OverrideRecord` appended to the evidence bundle SHALL carry an optional `kind` field of type `HumanInterventionKind`. When an operator override is recorded, the engine SHALL set `kind: "human-risk-override"`. The field is optional for backward compatibility: existing records without `kind` remain valid, and consumers SHALL treat an absent `kind` as `"unknown"`.

#### Scenario: operator override record includes kind field
- **WHEN** an operator supplies `--override "<key>: <reason>"`
- **THEN** the `OverrideRecord` written to `summary.json` SHALL contain `kind: "human-risk-override"`
- **AND** all existing override fields (`key`, `reason`, `at`, `sha`) SHALL remain present and unchanged

#### Scenario: override record without kind is treated as unknown by consumers
- **WHEN** a consumer reads an `OverrideRecord` that has no `kind` field (e.g. written by an older engine version)
- **THEN** the consumer SHALL treat the absent `kind` as `"unknown"` for aggregation
- **AND** it SHALL NOT throw or fail due to the missing field

### Requirement: summary.json includes a top-level interventions array at finalization
When `finalizeRun()` is called, `summary.json` SHALL include a top-level `interventions` field containing the array of all `human_intervention` event objects recorded during the run. This field is additive and optional: consumers that do not recognize it SHALL ignore it. The `interventions` array SHALL be the same records as the `human_intervention` events in `events.jsonl` for the same run, in chronological order.

#### Scenario: summary.json interventions matches events.jsonl human_intervention events
- **WHEN** `finalizeRun()` writes `summary.json` after a run with N `human_intervention` events
- **THEN** `summary.json` SHALL contain an `interventions` array with N objects
- **AND** each object in `interventions` SHALL be identical to the corresponding `human_intervention` line in `events.jsonl`

#### Scenario: summary.json with no interventions includes empty interventions array
- **WHEN** no `human_intervention` events were emitted during a run
- **THEN** `summary.json` SHALL contain `"interventions": []`
- **AND** `schema_version` SHALL remain `1`
