## ADDED Requirements

### Requirement: Offline progressive-planning evaluation SHALL join selected depth and risk class to primary outcomes without a collapsed score

Offline evaluation consumers for progressive-planning policy SHALL join planning-leverage records' selected `planning_depth` and `risk_class` / `risk_classes` to:

- first-pass acceptance indicators when defined by the evaluation design
- review effort counters and fix-round counts when present on leverage or material-rework records
- material rework classifications (`materiality` and `material_criteria`)
- production/rework outcomes via existing attribution (`production_outcome` or run/commit/pr joins) when evidence exists

Joins SHALL preserve attribution `authority` (`observed` vs `inferred`). Evaluation outputs SHALL NOT introduce `leverage_score`, `productivity_score`, or `expected_pain` as the primary success metric. Causal claims SHALL NOT be required; when reported rates are associational, consumers SHALL label them as such or as derived with availability metadata.

#### Scenario: cohort by depth and risk class

- **WHEN** an offline evaluation builds a cohort report over a time window
- **THEN** rows or groups SHALL be addressable by selected `planning_depth` and primary `risk_class` (or multi-class set)
- **AND** SHALL include sample size for each cohort when rates are shown

#### Scenario: material rework join does not become a productivity score

- **WHEN** evaluation reports material rework rates by planning depth
- **THEN** the report SHALL use `materiality` / criteria counts or rates
- **AND** SHALL NOT emit a single overall productivity or expected-pain score as the required summary field

#### Scenario: inferred production joins stay labeled

- **WHEN** a production_outcome link has `authority: "inferred"`
- **THEN** offline evaluation SHALL not present that join as observed fact
- **AND** SHALL partition or label inferred vs observed when both appear

#### Scenario: unavailable primary outcome is not zero-filled as success

- **WHEN** production outcomes or materiality are unavailable for a run
- **THEN** evaluation metrics that require those fields SHALL use unavailable/null labeling
- **AND** SHALL NOT treat missing production outcomes as successful zero-rework by default
