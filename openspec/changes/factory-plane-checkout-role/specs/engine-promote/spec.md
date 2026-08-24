## ADDED Requirements

### Requirement: Factory-pin self-dogfood SHALL be the live control checkout not GitHub owner/name

`pipeline factory-pin` self-dogfood authority SHALL be checkout role: the invocation directory is the live factory control checkout (factory-plane `REPO_DIR` or `AGENT_PIPELINE_FACTORY_CONTROL`), not a GitHub owner/name match and not a `package.json` `repository` field that names `accidental-hedge-fund/agent-pipeline`. A non-control clone of that GitHub repository SHALL NOT gain pin-write authority from repository identity.

`pipeline engine-promote` and `pipeline factory-pin promote` on the live factory control checkout SHALL write the live pin file `$REPO_DIR/.agent-pipeline/production-engine-pin.json` when `AGENT_PIPELINE_PRODUCTION_PIN` is unset. They SHALL NOT dual-write Hermes-state `~/.local/state/hermes-factory/production-engine-pin.json`. Explicit `--skip-frg` MAY still write a non-production `no-frg-*` marker; that marker SHALL NOT become pinned law on a developer clone.

#### Scenario: GitHub-name clone cannot self-dogfood a local pin

- **WHEN** an operator runs `pipeline factory-pin promote` from a non-control clone of `accidental-hedge-fund/agent-pipeline`
- **AND** `package.json` `repository` names `accidental-hedge-fund/agent-pipeline`
- **AND** neither factory-control directory nor an explicit pin path override is configured
- **THEN** the command SHALL refuse before writing `.agent-pipeline/production-engine-pin.json` under that clone
- **AND** SHALL NOT treat GitHub owner/name as self-dogfood

#### Scenario: Live control promote writes the control-checkout pin without PRODUCTION_PIN

- **WHEN** `pipeline engine-promote` or `pipeline factory-pin promote` succeeds on the live factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** factory-plane `REPO_DIR` is that checkout
- **THEN** the written pin SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** the promote path SHALL NOT also write `~/.local/state/hermes-factory/production-engine-pin.json`

#### Scenario: Skip-frg marker is not clone law

- **WHEN** `--skip-frg` writes a pin with `frg_run_id` `no-frg-X.Y.Z`
- **AND** a later `pipeline doctor` or `pipeline train` runs in a non-control clone that still contains that marker file
- **AND** two-track policy is inactive on that clone
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker
- **AND** `--skip-frg` SHALL remain a valid operator escape that writes a non-production marker
