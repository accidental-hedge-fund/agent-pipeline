## Purpose

Operational definition and telemetry for material rework versus ordinary review edits, including fix-round and review-effort linkage, so planning-leverage analysis does not treat every correction as equivalent material cost.

## ADDED Requirements

### Requirement: Material rework SHALL use a closed operational definition distinct from ordinary review edits

The engine SHALL classify correction work with `materiality` exactly one of `material`, `ordinary`, or `unknown`. A correction span or fix round SHALL be classified `material` only when at least one closed criterion code applies:

- `scope_expansion` — net expansion of production paths/modules beyond the original plan or scope boundary (not formatting-only and not test-only churn unless product contract tests redefine external behavior)
- `design_interface_change` — public API, schema, wire format, or persisted data model change introduced during fix rounds after initial candidate review
- `replan_or_assumption_reopen` — planning artifacts revised, or previously resolved assumptions reopened, in response to review or fix
- `multi_round_blocking` — two or more fix rounds addressing blocking findings at or above the active review block threshold, or an engine-recorded architecture/correctness material class for the round

When none of the criteria apply and evidence is sufficient to classify, `materiality` SHALL be `ordinary` and `material_criteria` SHALL be an empty array. When evidence is insufficient, `materiality` SHALL be `unknown` rather than defaulting to `material`. Every review edit SHALL NOT automatically qualify as material rework.

#### Scenario: formatting-only fix is ordinary

- **WHEN** a fix round only reformats code or renames locals without scope expansion, interface change, replan, or multi-round blocking
- **THEN** `materiality` SHALL be `"ordinary"`
- **AND** `material_criteria` SHALL be empty

#### Scenario: schema change in fix round is material

- **WHEN** a fix round changes a persisted data model or public API after initial review of the candidate
- **THEN** `materiality` SHALL be `"material"`
- **AND** `material_criteria` SHALL include `"design_interface_change"`

#### Scenario: two blocking fix rounds meet multi_round_blocking

- **WHEN** two fix rounds each address blocking findings at or above the block threshold for the same run
- **THEN** the material-rework classification for that correction span SHALL include criterion `"multi_round_blocking"`
- **AND** `materiality` SHALL be `"material"`

#### Scenario: insufficient evidence is unknown not material

- **WHEN** the engine cannot determine whether a fix round expanded scope or changed interfaces
- **THEN** `materiality` SHALL be `"unknown"`
- **AND** SHALL NOT default to `"material"`

---

### Requirement: Material-rework records SHALL carry versioned identity, fix-round, and review-effort fields

The engine SHALL define a material-rework telemetry record with integer `record_schema_version` starting at `1`. Schema version `1` SHALL include at least:

- `record_schema_version` — integer, value `1`
- `type` — identifier for material-rework telemetry
- `run_id` — string
- `issue` — integer or null
- `materiality` — `material` | `ordinary` | `unknown`
- `material_criteria` — array of criterion codes from the closed set (possibly empty)
- `fix_round` — positive integer when tied to a numbered fix round, else null
- `review_effort` — object with `findings_blocking`, `findings_advisory`, `re_review_count` each an integer or null with availability labeling
- `phase_instance_id` — optional link to a correction-phase interval
- `evidence_refs` — optional bounded refs (finding keys, SHAs) without secrets
- `attribution` — optional linkage array consistent with planning-leverage / outcome-linkage
- duration/cost fields for the correction span following the same elapsed vs active vs unknown rules as planning-leverage-telemetry

Readers SHALL ignore unknown fields. The record SHALL NOT define a collapsed rework severity score that replaces materiality and criteria.

#### Scenario: material record includes criteria and fix round

- **WHEN** fix round 2 is classified material due to scope expansion
- **THEN** the record SHALL include `materiality: "material"`, `material_criteria` containing `"scope_expansion"`, and `fix_round: 2`

#### Scenario: review effort counters are explicit when known

- **WHEN** a fix round addresses 3 blocking and 1 advisory finding with one re-review
- **THEN** `review_effort.findings_blocking` SHALL be `3`
- **AND** `review_effort.findings_advisory` SHALL be `1`
- **AND** `review_effort.re_review_count` SHALL be `1`

#### Scenario: unknown review effort is not zero-filled as fact

- **WHEN** finding counts for a round are not available
- **THEN** the corresponding counters SHALL be null with unavailable labeling
- **AND** SHALL NOT be written as `0` to mean unknown

---

### Requirement: Material rework telemetry SHALL distinguish in-pipeline correction from post-delivery production rework

Material-rework telemetry described by this capability measures **in-pipeline** correction after review (fix rounds / correction phase). It SHALL NOT by itself assert a production `follow_up_rework` or other #576 `production_outcome` kind. Optional attribution to a `production_outcome` id is allowed only when evidence exists; absence of production outcomes SHALL NOT mark in-pipeline work non-material.

#### Scenario: material fix without production outcome remains material

- **WHEN** a run has material fix rounds and no production-outcome records
- **THEN** material-rework telemetry MAY still record `materiality: "material"`
- **AND** SHALL NOT require a production_outcome attribution entry

#### Scenario: production follow_up_rework is a separate join

- **WHEN** a later #576 `follow_up_rework` outcome is linked to the same run
- **THEN** planning-leverage / material-rework reporting MAY join on run or outcome id
- **AND** SHALL present the production outcome as a distinct observation, not as a rename of the in-pipeline materiality field

---

### Requirement: Tests SHALL cover positive and negative materiality classification

Unit tests with injected fixtures SHALL cover at least: (1) ordinary formatting-only fix, (2) material design/interface change, (3) material multi-round blocking, (4) unknown when evidence is missing. Tests SHALL prove that ordinary cases do not emit `materiality: "material"`.

#### Scenario: negative case locks ordinary classification

- **WHEN** the ordinary formatting-only fixture is classified
- **THEN** tests SHALL assert `materiality === "ordinary"`
- **AND** SHALL assert `material_criteria` is empty

#### Scenario: positive case locks material classification

- **WHEN** the design-interface-change fixture is classified
- **THEN** tests SHALL assert `materiality === "material"`
- **AND** SHALL assert `"design_interface_change"` is present in `material_criteria`
