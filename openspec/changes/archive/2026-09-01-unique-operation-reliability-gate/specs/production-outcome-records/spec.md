## ADDED Requirements

### Requirement: Production-outcome attribution SHALL consume logical_operation_id when present

When a `production_outcome` record attributes to a pipeline run that stores `logical_operation_id`, the attribution SHALL include that identifier (or an attribution target that names it) rather than treating GitHub labels or comment prose as unique-operation success. Readers SHALL ignore the additive field when absent. Outcome ingest SHALL NOT invent a logical identity and SHALL NOT reclassify labels into a parallel reliability success rate.

#### Scenario: Observed run attribution carries the logical identity

- **WHEN** an adapter records a `delivery` outcome attributed to a run whose `run.json` contains `logical_operation_id` `L`
- **THEN** the stored attribution SHALL name `L` or the run that persists `L`
- **AND** SHALL NOT claim unique-operation verified completion from a `pipeline:ready-to-deploy` label alone

#### Scenario: Historical outcomes without logical identity remain valid

- **WHEN** a `production_outcome` attributes to a historical run that has no `logical_operation_id`
- **THEN** the record SHALL remain valid
- **AND** unique-operation scoreboard consumption SHALL treat that linkage as missing correlation rather than inferred success
