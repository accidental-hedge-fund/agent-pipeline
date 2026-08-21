## ADDED Requirements

### Requirement: Tugboat SHALL NOT bind a Hermes-state pin file as the default

Tugboat SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to `$REPO_DIR/.agent-pipeline/production-engine-pin.json` when that variable is unset or empty, even if `~/.local/state/hermes-factory/production-engine-pin.json` exists on the host. Tugboat SHALL NOT treat presence of that Hermes-state file as a reason to set the env to it. An already-set operator value SHALL still be left unchanged.

#### Scenario: Unset env binds control pin while Hermes-state file exists

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** `~/.local/state/hermes-factory/production-engine-pin.json` exists on the host
- **THEN** Tugboat SHALL export `AGENT_PIPELINE_PRODUCTION_PIN` to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** it SHALL NOT set the env to the Hermes-state path because that file exists

#### Scenario: Operator override remains unchanged

- **WHEN** Tugboat starts a ship
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is already set to `/custom/pin.json`
- **THEN** Tugboat SHALL leave that value unchanged
