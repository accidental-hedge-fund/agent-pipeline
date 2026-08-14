# assumption-lineage Specification

## Purpose
Stable assumption and open-question identities with resolution status that survive from planning into implementation and review, so planning-leverage telemetry can measure unresolved uncertainty without losing lineage or silently dropping questions.

## Requirements

### Requirement: Assumptions and open questions SHALL carry stable identities and closed resolution status

The engine SHALL represent each assumption or open question as a lineage record with integer `record_schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `record_schema_version` — integer, value `1`
- `type` — constant or event type identifying assumption lineage
- `assumption_id` — stable string unique within the run
- `kind` — exactly one of `assumption`, `open_question`
- `statement` — bounded redacted human-readable text
- `introduced_phase` — one of `alignment`, `planning`, `implementation`, `review`, `correction`
- `status` — exactly one of `open`, `resolved`, `invalidated`, `deferred`, `unknown`
- `status_updated_at` — ISO 8601 timestamp of the latest status change
- `run_id` — string run identity
- optional `resolution` object with bounded redacted `note` and `resolved_in_phase`
- optional `evidence_refs` array of bounded references without secrets

`assumption_id` SHALL remain stable across status updates for the same logical item. Readers SHALL ignore unknown fields for forward compatibility.

#### Scenario: new assumption receives a stable id and open status

- **WHEN** planning records a new assumption during the `planning` phase
- **THEN** the lineage record SHALL include a non-empty `assumption_id`
- **AND** `kind` SHALL be `"assumption"`
- **AND** `status` SHALL be `"open"`
- **AND** `introduced_phase` SHALL be `"planning"`

#### Scenario: open question uses the same identity contract

- **WHEN** planning records an open question
- **THEN** the lineage record SHALL use `kind: "open_question"`
- **AND** SHALL include `assumption_id`, `status`, and `introduced_phase` under the same schema

#### Scenario: status enum rejects free-form values

- **WHEN** a producer constructs a lineage record
- **THEN** `status` SHALL be one of `open`, `resolved`, `invalidated`, `deferred`, `unknown`
- **AND** validation SHALL reject other status strings

---

### Requirement: Status updates SHALL preserve identity and retain history in the event stream

When an assumption or open question changes status, the engine SHALL emit an update that reuses the same `assumption_id` and sets a new `status` and `status_updated_at`. The engine SHALL NOT assign a new `assumption_id` solely because status changed. The append-only event stream SHALL retain prior lineage events so consumers can reconstruct history; current-state readers SHALL use the latest event per `assumption_id` for that run.

#### Scenario: resolve reuses assumption_id

- **WHEN** an assumption with `assumption_id: "A1"` is resolved during `implementation`
- **THEN** the update event SHALL carry `assumption_id: "A1"`
- **AND** `status` SHALL be `"resolved"`
- **AND** `resolution.resolved_in_phase` SHALL be `"implementation"` when known

#### Scenario: history remains available

- **WHEN** an assumption moves from `open` to `resolved`
- **THEN** both the original open event and the resolve event SHALL remain readable from the run event stream
- **AND** a current-state projection SHALL report `status: "resolved"` for that `assumption_id`

#### Scenario: reopen after resolve keeps the same id

- **WHEN** a previously resolved assumption is invalidated or reopened during review
- **THEN** the update SHALL keep the same `assumption_id`
- **AND** `status` SHALL become `invalidated` or `open` as appropriate
- **AND** the engine SHALL NOT create a second identity for the same logical item

---

### Requirement: Unresolved assumptions SHALL be carry-forward visible into later phases

Assumptions and open questions with status `open` or `deferred` at the end of planning SHALL remain queryable during implementation and review telemetry for the same run. The engine SHALL NOT drop open items solely because the stage advanced. Reporting that summarizes unresolved planning uncertainty SHALL count only items whose latest status is `open` or `deferred` unless the consumer explicitly requests other statuses.

#### Scenario: open assumption still visible after planning ends

- **WHEN** planning completes with an assumption still `open`
- **AND** implementation phase telemetry is emitted for the same run
- **THEN** a current-state projection of assumption lineage for that run SHALL still include that `assumption_id` with status `open`

#### Scenario: resolved items are not counted as unresolved

- **WHEN** an assumption is `resolved` before review starts
- **THEN** unresolved-assumption counts for review-phase leverage reporting SHALL NOT include that item

---

### Requirement: Assumption free text SHALL be redacted and SHALL exclude secrets and raw model content

`statement` and resolution notes SHALL pass injection denylist and secret redaction before persistence. Lineage records SHALL NOT store raw prompts, model transcripts, source dumps, or authentication secrets. Evidence references SHALL be identifiers or paths already acceptable under run-store privacy rules, not embedded secret material.

#### Scenario: secret in statement is redacted

- **WHEN** an assumption statement contains a recognized secret pattern
- **THEN** the persisted lineage record SHALL store the redacted form only

#### Scenario: evidence ref is identifier-only

- **WHEN** a resolution cites a review finding
- **THEN** `evidence_refs` SHALL carry a bounded id such as a finding key
- **AND** SHALL NOT embed the full raw model review transcript
