## ADDED Requirements

### Requirement: The factory plane SHALL use one live production pin file

The factory plane SHALL treat `$REPO_DIR/.agent-pipeline/production-engine-pin.json` as the single live production pin file unless the operator has explicitly set `AGENT_PIPELINE_PRODUCTION_PIN` to that same path. Claude Code and Hermes are both hosts. Pin authority SHALL be the factory control checkout, not a Hermes-only JSON. In-repo host supervisor SKILL and env templates SHALL NOT default `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`. When that env is unset, factory ship composers SHALL bind the control-checkout pin. `engine-promote` SHALL write exactly one file at the resolved path and SHALL NOT dual-write a Hermes-state copy. On the factory plane, `pipeline doctor` SHALL fail (status `"fail"`, not `"warn"` or `"pass"`) when the effective production pin (resolved by `production_engine_pin_path` → `AGENT_PIPELINE_PRODUCTION_PIN` → the control-checkout pin) is a readable file whose `version` or `git_sha` disagrees with the control-checkout pin. A later packaging template (including v1.40.1 env templating) SHALL NOT reintroduce a second live pin path.

#### Scenario: Unset env uses the control-checkout pin

- **WHEN** a factory ship runs on the control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** the process SHALL bind `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** subsequent `engine-promote` and `pipeline doctor` SHALL use that path

#### Scenario: Host SKILL does not default the Hermes-state pin

- **WHEN** the in-repo Hermes/Buzz supervisor SKILL is read
- **THEN** it SHALL NOT default `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`
- **AND** unset SHALL remain unset so Tugboat can bind the control-checkout pin

#### Scenario: Doctor fails when env pin and control pin disagree

- **WHEN** `REPO_DIR` is the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` points at a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** that file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** `pipeline doctor` SHALL report status `"fail"` for the pin-path check
- **AND** the status SHALL NOT be `"warn"` or `"pass"`

#### Scenario: Doctor fails when configured pin override disagrees with control pin

- **WHEN** `REPO_DIR` is the factory control checkout
- **AND** `production_engine_pin_path` points at a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** that file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** `pipeline doctor` SHALL report status `"fail"` for the pin-path check
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** the check SHALL still fail when `AGENT_PIPELINE_PRODUCTION_PIN` is unset or set to the control-checkout pin

#### Scenario: Promote writes exactly one pin file

- **WHEN** `pipeline engine-promote` succeeds for a version
- **THEN** it SHALL write the resolved pin path only
- **AND** it SHALL NOT also write `~/.local/state/hermes-factory/production-engine-pin.json`
