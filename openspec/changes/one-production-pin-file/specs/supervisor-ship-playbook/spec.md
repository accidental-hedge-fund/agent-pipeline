## ADDED Requirements

### Requirement: Hermes supervisor SKILL SHALL NOT default a second production pin path

The in-repo Hermes/Buzz supervisor SKILL (`examples/supervisor/hermes/SKILL.md` and any generated or installed copy the product owns) SHALL NOT default `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`. Unset SHALL remain unset so Tugboat can bind `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. `examples/supervisor/hermes/env.example` SHALL NOT document a second live pin path. If that file shows `AGENT_PIPELINE_PRODUCTION_PIN`, the value SHALL be the control-checkout pin. A unit test SHALL fail if the SKILL or `env.example` still defaults or documents the Hermes-state pin path. A later packaging template SHALL NOT reintroduce that second path.

#### Scenario: SKILL has no Hermes-state pin default

- **WHEN** `examples/supervisor/hermes/SKILL.md` is read
- **THEN** it SHALL NOT contain a default assignment of `AGENT_PIPELINE_PRODUCTION_PIN` to `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json`
- **AND** it SHALL NOT instruct the host to export that Hermes-state path when the env is unset

#### Scenario: env.example has no second live pin path

- **WHEN** `examples/supervisor/hermes/env.example` is read
- **THEN** it SHALL NOT document `~/.local/state/hermes-factory/production-engine-pin.json` or `$HOME/.local/state/hermes-factory/production-engine-pin.json` as a live pin
- **AND** if `AGENT_PIPELINE_PRODUCTION_PIN` is shown, the value SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json` or an equivalent control-checkout pin

#### Scenario: Drift-guard test fails on Hermes-state default

- **WHEN** unit tests read the in-repo Hermes SKILL and `env.example`
- **THEN** the tests SHALL fail if either file defaults or documents the Hermes-state pin path
- **AND** no real network, git, or subprocess call SHALL occur
