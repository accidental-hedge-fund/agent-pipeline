## ADDED Requirements

### Requirement: Tugboat SHALL export AGENT_PIPELINE_PRODUCTION_PIN to the factory pin

At process start, after Tugboat resolves `REPO_DIR`, Tugboat SHALL export
`AGENT_PIPELINE_PRODUCTION_PIN` when that variable is unset or empty. The exported
value SHALL be the factory pin file: the factory control checkout
`.agent-pipeline/production-engine-pin.json` (absolute path). Tugboat SHALL NOT
retarget the pin from session, model, or free-text overrides. An operator-set
`AGENT_PIPELINE_PRODUCTION_PIN` SHALL be left unchanged.

Default Tugboat `pipeline release` and `pipeline engine-promote` argv SHALL continue
to omit `--skip-frg` unless the logged-reason operator escape is active.

#### Scenario: Unset pin env is exported to the factory pin

- **WHEN** Tugboat starts a ship and `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** the Tugboat process environment SHALL contain
  `AGENT_PIPELINE_PRODUCTION_PIN` set to the factory control checkout
  `.agent-pipeline/production-engine-pin.json`
- **AND** the `engine-promote` child SHALL inherit that value

#### Scenario: Operator pin path is not overwritten

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is already set to `/custom/pin.json`
- **THEN** Tugboat SHALL leave that value unchanged

#### Scenario: Default promote argv still omits skip-frg

- **WHEN** Tugboat reaches engine-promote and the operator escape is not active
- **THEN** the promote invocation SHALL NOT include `--skip-frg`
