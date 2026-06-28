## ADDED Requirements

### Requirement: stage_accounting events are recorded in events.jsonl

The orchestrator and harness invocation paths SHALL append a `stage_accounting`
event whenever a stage accounting record is produced. The event SHALL contain
the base event fields `schema_version`, `type: "stage_accounting"`, and `at`,
plus the complete stage accounting record fields defined by the
`stage-cost-accounting` capability. The event type is additive and SHALL NOT
change the meaning of existing `stage_start`, `stage_complete`, `run_start`, or
`run_complete` events.

#### Scenario: stage_accounting event appended after harness invocation

- **WHEN** a stage harness invocation returns and a stage accounting record is
  produced
- **THEN** a `stage_accounting` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain the stage, harness, model slot/model
  identifier, duration, outcome, and cost source for that invocation

#### Scenario: stage_accounting streams in json-events mode

- **WHEN** the pipeline runs with `--json-events`
- **AND** a `stage_accounting` event is appended to `events.jsonl`
- **THEN** the same JSON line SHALL also be written to stdout

#### Scenario: stage lifecycle reconstruction ignores accounting events

- **WHEN** a consumer reconstructs the stage timeline by filtering for
  `stage_start` and `stage_complete` events
- **THEN** `stage_accounting` events SHALL be excluded by the type filter
- **AND** the reconstructed timeline SHALL be identical to a log without
  `stage_accounting` events
