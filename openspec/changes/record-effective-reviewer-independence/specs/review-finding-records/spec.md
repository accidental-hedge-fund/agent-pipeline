## ADDED Requirements

### Requirement: Persisted review rounds SHALL record independence coverage when available

Persisted review rounds (inside existing run-directory artifacts `events.jsonl` and/or `summary.json`) SHALL include, when produced by the shared reviewer seam, additive fields for: per-attempt lineage (provider family, model family, configured harness, effective harness, self_review, usable/failed, failure/fallback reason when present, latency when known, cost coverage class when known), round coverage counts (`configured`, `attempted`, `usable`, `independent`, `required`), and the closed aggregation outcome with reason. Fields SHALL be optional for historical records so `schema_version` need not break. Single-agent rounds SHALL be allowed to omit multi-agent arrays while still recording counts and lineage for the one attempt. The run directory SHALL NOT require a new well-known file solely for independence coverage.

#### Scenario: ensemble round persists coverage and lineage

- **WHEN** an ensemble review round completes with two agents
- **THEN** the persisted round SHALL list both agents with lineage and self_review fields
- **AND** SHALL include configured/attempted/usable/independent/required counts
- **AND** SHALL include the aggregation outcome

#### Scenario: single-agent round remains valid

- **WHEN** a review round runs with ensemble disabled
- **THEN** the persisted round MAY omit multi-agent arrays
- **AND** SHALL still be valid without requiring the new fields for older writers
- **AND** when the new writer runs, it SHALL record counts with configured 1 and lineage for the single attempt

#### Scenario: no new run-directory file for coverage

- **WHEN** independence coverage is persisted for a run
- **THEN** it SHALL be carried within `events.jsonl` and/or `summary.json`
- **AND** the run directory SHALL NOT require a new well-known file solely for independence coverage

#### Scenario: quorum_unmet still persists union findings

- **WHEN** aggregation outcome is `quorum_unmet` and usable agents produced findings
- **THEN** the persisted findings array SHALL still be the merged union set from usable agents
- **AND** SHALL NOT be empty solely because quorum failed
