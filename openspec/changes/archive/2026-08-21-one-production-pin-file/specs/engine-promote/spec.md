## ADDED Requirements

### Requirement: Engine-promote SHALL write exactly one production pin file

A successful `pipeline engine-promote` SHALL write the production pin to exactly one file: the path resolved by override → `AGENT_PIPELINE_PRODUCTION_PIN` → `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. The promote path SHALL NOT dual-write a second copy under `~/.local/state/hermes-factory/production-engine-pin.json` (or `$HOME/.local/state/hermes-factory/production-engine-pin.json`). A unit test SHALL fail if a successful promote writes that Hermes-state path in addition to the resolved path.

#### Scenario: Resolved factory pin is the only write

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` is `/factory/.agent-pipeline/production-engine-pin.json`
- **AND** non-skip `pipeline engine-promote --for 1.39.7` succeeds
- **THEN** `/factory/.agent-pipeline/production-engine-pin.json` SHALL contain `version` `1.39.7`
- **AND** the promote path SHALL NOT write `~/.local/state/hermes-factory/production-engine-pin.json`

#### Scenario: Unset env writes the control-checkout pin only

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** promote `repoDir` is the factory control checkout `/factory`
- **AND** non-skip `pipeline engine-promote --for 1.39.7` succeeds
- **THEN** the written pin SHALL be `/factory/.agent-pipeline/production-engine-pin.json`
- **AND** the promote path SHALL NOT also write a Hermes-state pin file

#### Scenario: Dual-write regression test fails closed

- **WHEN** unit tests invoke successful promote with injected file writes
- **THEN** the recorded write set SHALL contain exactly one pin path
- **AND** the same suite SHALL fail if a Hermes-state pin path is also written
- **AND** no real network, git, or subprocess call SHALL occur
