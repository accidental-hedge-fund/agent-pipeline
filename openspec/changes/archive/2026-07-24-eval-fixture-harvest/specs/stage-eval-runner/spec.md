## MODIFIED Requirements

### Requirement: Every cell record SHALL carry the identity keys needed to join it to normal run evidence

Every cell record SHALL include `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
`prompt_hash`, `config_hash`, `base_sha`, and the fixture's `env_surface_hash` (the
environment-and-surface provenance hash). `prompt_hash` SHALL be computed over the materialized
prompt text used for that cell, `config_hash` over the effective configuration for that cell, and
`env_surface_hash` SHALL be carried from the fixture's resolved environment-fidelity contract and
resolved capability surface — so that a prompt-template change, a configuration change, or an
environment/surface change is each detectable as a difference between populations.

#### Scenario: Identity keys are present on every record

- **WHEN** any cell record is read from the experiment output
- **THEN** it SHALL contain `experiment_id`, `fixture_id`, `treatment_id`, `replicate`,
  `prompt_hash`, `config_hash`, `base_sha`, and `env_surface_hash`

#### Scenario: Prompt and config changes are visible as hash differences

- **WHEN** two cells are executed with the same fixture and treatment but a different
  materialized prompt or a different effective configuration
- **THEN** their `prompt_hash` or `config_hash` values SHALL differ

#### Scenario: An environment or surface change is visible as a hash difference

- **WHEN** two cells are executed for fixtures identical except for one dependency's environment
  mode or a difference in the resolved capability surface
- **THEN** their `env_surface_hash` values SHALL differ

#### Scenario: A cell joins to ordinary run evidence

- **WHEN** a cell record and an ordinary pipeline run artifact are compared
- **THEN** the recorded identity keys SHALL be sufficient to determine whether they describe the
  same fixture, treatment, and base commit
