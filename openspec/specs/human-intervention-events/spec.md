# human-intervention-events Specification

## Purpose
TBD - created by archiving change human-intervention-taxonomy. Update Purpose after archive.
## Requirements
### Requirement: A human_intervention event is emitted at every pipeline block, exit, or override
The engine SHALL append a `human_intervention` event to `events.jsonl` at every point where the pipeline:

- Sets a blocking condition (via `blocker_set` or equivalent)
- Transitions to `needs-human`
- Records an operator override (via `--override`)
- Exits a stage due to ambiguity, product-judgment, or tooling failure

The `human_intervention` event SHALL be emitted **in addition to** any existing `blocker_set`, `blocker_cleared`, or override record — it does not replace them. The original blocker message, finding key, or override key SHALL be preserved in the event's `detail` field.

The event shape SHALL be:
```
{
  schema_version: 1,
  type: "human_intervention",
  at: <ISO 8601 UTC string>,
  kind: <HumanInterventionKind>,
  stage: <stage name string | null>,
  issue: <issue number integer>,
  detail: <string — original blocker message, finding key, or override key>,
  ref: <string | null>  // finding key, override key, or PR number for correlation
}
```

The `detail` and `ref` fields SHALL be subject to the write-time injection denylist already applied to all `events.jsonl` records.

#### Scenario: blocker_set triggers human_intervention event
- **WHEN** a stage sets a blocking condition (e.g. test failure, review ceiling)
- **THEN** a `human_intervention` event SHALL be appended to `events.jsonl` after the `blocker_set` event
- **AND** the event SHALL carry the corresponding `kind` from the taxonomy
- **AND** the event SHALL carry the original blocker message in `detail`
- **AND** the `blocker_set` event SHALL still be written unchanged

#### Scenario: operator override triggers human_intervention event
- **WHEN** an operator supplies `--override "<key>: <reason>"`
- **THEN** a `human_intervention` event SHALL be appended to `events.jsonl`
- **AND** `kind` SHALL be `"human-risk-override"`
- **AND** `detail` SHALL contain the override key
- **AND** `ref` SHALL contain the override key for correlation

#### Scenario: needs-human transition triggers human_intervention event
- **WHEN** the pipeline transitions the issue to `needs-human` (e.g. review ceiling reached)
- **THEN** a `human_intervention` event SHALL be appended with `kind: "review-non-convergence"`
- **AND** `stage` SHALL be `"review"` or the stage where the ceiling was reached
- **AND** `detail` SHALL contain the ceiling or blocking finding description

#### Scenario: intervention event payload passes injection denylist
- **WHEN** the `detail` or `ref` field of a `human_intervention` event contains a secret pattern (e.g. an API key assignment)
- **THEN** the matching span SHALL be replaced with `[REDACTED-INJECTION]` before the line is appended
- **AND** the event SHALL still be written (not dropped)

#### Scenario: intervention event is additive — does not affect stage outcome
- **WHEN** appending a `human_intervention` event throws an I/O error
- **THEN** the stage outcome SHALL not be affected (consistent with run-artifact-conventions)
- **AND** a warning SHALL be logged

### Requirement: The emitter is a pure helper function in intervention.ts
The engine SHALL provide `emitHumanIntervention(deps, payload)` in `core/scripts/intervention.ts`. This function SHALL accept an `appendEvent`-compatible deps object and a payload containing `kind`, `stage`, `issue`, `detail`, and optionally `ref`. It SHALL construct the full event record, apply `schema_version: 1`, and call `appendEvent`. It SHALL be a total function: any emission failure SHALL be caught internally and logged as a warning without propagating.

#### Scenario: emitter constructs valid event
- **WHEN** `emitHumanIntervention` is called with a valid payload
- **THEN** the resulting event in `events.jsonl` SHALL contain `schema_version`, `type: "human_intervention"`, `at`, `kind`, `stage`, `issue`, and `detail`
- **AND** `ref` SHALL be present when supplied, absent when not

#### Scenario: emitter does not throw on append failure
- **WHEN** the underlying `appendEvent` call throws
- **THEN** `emitHumanIntervention` SHALL catch the error, log a warning, and return without re-throwing

