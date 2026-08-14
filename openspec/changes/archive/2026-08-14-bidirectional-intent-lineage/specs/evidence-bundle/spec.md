## ADDED Requirements

### Requirement: Evidence surfaces SHALL expose lineage export slices and drift reason codes

When lineage data exists for a run, finalized evidence surfaces (evidence bundle and/or `summary.json` and the human-readable summary path) SHALL expose a lineage section that includes at least:

- schema version of the lineage export slice
- counts of nodes and edges relevant to the run (or explicit zero with reason)
- key objective ids linked to the run when present
- any computed forward impact or backward proposal references for the run
- stable drift reason codes when impact analysis was run

Absence of a hosted UI SHALL NOT prevent operators from reading these fields via JSON or human-readable summary. Missing lineage for a run SHALL be explicit (empty section or skip reason), not silent success that implies complete attribution.

#### Scenario: human-readable summary includes drift codes when impact ran

- **WHEN** forward impact analysis records `objective_content_hash_changed` for a run's objective
- **AND** the human-readable summary is printed
- **THEN** the summary SHALL include that drift reason code
- **AND** SHALL name the affected objective id or bounded summary

#### Scenario: JSON export is available without UI

- **WHEN** an operator requests lineage or evidence JSON for a run with projected edges
- **THEN** the export SHALL include the lineage section fields above
- **AND** SHALL be consumable without a hosted UI

#### Scenario: missing lineage is explicit

- **WHEN** a run finalizes before any lineage projection exists
- **THEN** the evidence surface SHALL omit the section or record an explicit skip/empty reason
- **AND** SHALL NOT claim complete intent-to-outcome attribution
