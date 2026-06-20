## ADDED Requirements

### Requirement: gh_metrics_summary carries schema_version and follows non-fatal write convention
The `gh_metrics_summary` event type SHALL be treated as a machine-readable run artifact record. It SHALL include a top-level `schema_version` integer field (initial value `1`). Its write path SHALL wrap `appendFile` in a try/catch and log a warning on failure, consistent with the non-fatal write convention established for all other run artifact writes.

#### Scenario: gh_metrics_summary record includes schema_version
- **WHEN** the `gh_metrics_summary` event is serialized and appended to `events.jsonl`
- **THEN** the JSON line SHALL contain `"schema_version": 1`

#### Scenario: write failure is non-fatal
- **WHEN** the `appendFile` call for the `gh_metrics_summary` record throws an I/O error
- **THEN** the engine SHALL catch the error, log a warning, and NOT propagate the failure to the caller
- **AND** all subsequent pipeline finalization steps SHALL still execute
