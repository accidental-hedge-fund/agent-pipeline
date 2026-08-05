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

### Requirement: human_intervention events SHALL carry or inherit engine and discovery attribution

Each newly emitted `human_intervention` event SHALL expose engine version, engine commit
SHA (or explicit unresolved), and discovery-channel either as additive event fields or via
the documented inheritance rule from `run.json` / run-level defaults used by scoreboard
collectors. New producers SHALL resolve discovery-channel at write time from the caller's
validated channel when present, else from the active run's persisted `run.json`
`discovery_channel` stamp when present, and SHALL write that value on the event when
resolved. Producers SHALL NOT invent `live-run` when neither source yields a closed-set
channel; unresolved channel MAY omit the field and MAY emit a non-fatal diagnostic.
Emission SHALL remain non-fatal: attribution enrichment failure SHALL NOT change the stage
outcome. Existing required fields (`schema_version`, `type`, `at`, `kind`, `stage`,
`issue`, `detail`, optional `ref`) SHALL remain.

#### Scenario: Override intervention is attributable

- **WHEN** an operator supplies `--override` and a `human_intervention` event with kind
  `human-risk-override` is appended
- **THEN** scoreboard human-touch collectors SHALL be able to read engine identity and
  discovery-channel for that event via inline fields or documented inheritance
- **AND** `kind` SHALL remain `human-risk-override`

#### Scenario: Write-time discovery channel from run stamp

- **WHEN** a `human_intervention` event is emitted without a caller-supplied
  `discovery_channel`
- **AND** the active run's `run.json` has a valid `discovery_channel` (for example
  `review-batch`)
- **THEN** the written event SHALL include that `discovery_channel` inline
- **AND** SHALL NOT invent `live-run` in place of the run stamp

#### Scenario: Unresolved discovery channel is not invented as live-run

- **WHEN** a `human_intervention` event is emitted without a caller channel
- **AND** no valid run-level `discovery_channel` stamp is available
- **THEN** the event SHALL still be written with its core fields
- **AND** SHALL NOT set `discovery_channel` to `live-run` by default
- **AND** a non-fatal unresolved-attribution diagnostic MAY be recorded

#### Scenario: Attribution enrichment failure is non-fatal

- **WHEN** engine identity cannot be resolved at intervention emission time
- **THEN** the `human_intervention` event SHALL still be written with its core fields
- **AND** unresolved identity SHALL be explicit or inherit as null/unknown
- **AND** the stage outcome SHALL not change solely due to missing identity

#### Scenario: Historical intervention without new fields remains countable

- **WHEN** a pre-change `human_intervention` event lacks engine and discovery fields
- **THEN** human-touch aggregates SHALL still count the event as a touch when kind is in
  scope
- **AND** missing-attribution evidence MAY be recorded without crashing the scan

