## ADDED Requirements

### Requirement: Factory-plane doctor SHALL fail when the env pin disagrees with the control pin

On the factory plane (`REPO_DIR` is the factory control checkout), `pipeline doctor` SHALL include an additive preflight check (stable id in the `install:` family) that compares the effective production-pin path to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. The effective path SHALL be resolved in the same order as `engine-promote`: `production_engine_pin_path` override → `AGENT_PIPELINE_PRODUCTION_PIN` → `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. When the effective path is a different resolved file from the control-checkout pin and both files are readable and their `version` or `git_sha` disagree, the check SHALL have status `"fail"`. The check SHALL NOT use `"warn"` or `"pass"` for that disagreement. Remediation SHALL name both paths. When the winning source is the env, remediation SHALL instruct the operator to unset the env (so Tugboat binds the control pin) or to point the env at the control-checkout pin. When the winning source is `production_engine_pin_path`, remediation SHALL name that override. When both override and env are unset, when the effective path and the control-checkout pin resolve to the same file, or when `version` and `git_sha` agree, this check SHALL NOT fail for split-pin disagreement. Ordinary non-factory product repositories SHALL skip this check. A unit test SHALL fail if env pin and control pin disagree and the result is pass. A unit test SHALL fail if a divergent `production_engine_pin_path` disagrees with the control pin and the result is pass, both when `AGENT_PIPELINE_PRODUCTION_PIN` is unset and when that env points at the control-checkout pin. The check SHALL obtain pin contents through injected `DoctorDeps` file-read primitives so unit tests perform no real filesystem, network, git, or subprocess calls.

#### Scenario: Env pin version disagrees with control pin — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is `/home/user/.local/state/hermes-factory/production-engine-pin.json`
- **AND** that file has `version` `1.39.6` and `git_sha` `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- **AND** `$REPO_DIR/.agent-pipeline/production-engine-pin.json` has `version` `1.39.7` and `git_sha` `e206cfdabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** remediation SHALL name both pin paths

#### Scenario: Env pin git_sha disagrees at the same version — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to a different readable file from the control-checkout pin
- **AND** both files have `version` `1.39.7`
- **AND** their `git_sha` values differ
- **THEN** the pin-path check SHALL have status `"fail"`

#### Scenario: Matching env pin identity does not fail this check

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to a different readable file from the control-checkout pin
- **AND** both files have the same `version` and the same `git_sha`
- **THEN** the pin-path check SHALL NOT fail for split-pin disagreement

#### Scenario: Unset env skips split-pin fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** `production_engine_pin_path` is unset
- **THEN** the pin-path check SHALL NOT fail for split-pin disagreement
- **AND** pin resolution SHALL use `$REPO_DIR/.agent-pipeline/production-engine-pin.json`

#### Scenario: Configured pin override disagrees with control pin — unset env — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `production_engine_pin_path` is a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **AND** that override file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** remediation SHALL name the override path and the control-checkout pin

#### Scenario: Configured pin override disagrees with control pin — env points at control pin — fail

- **WHEN** `pipeline doctor` runs on the factory control checkout
- **AND** `production_engine_pin_path` is a readable file other than `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is set to `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** that override file's `version` or `git_sha` disagrees with the control-checkout pin
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the status SHALL NOT be `"warn"` or `"pass"`
- **AND** the check SHALL NOT skip as same-path because the env matches the control pin

#### Scenario: Non-factory doctor skips the split-pin check

- **WHEN** `pipeline doctor` runs on a non-factory product repository
- **AND** no factory-plane `REPO_DIR` applies
- **THEN** the pin-path check SHALL skip
- **AND** SHALL NOT fail solely because a Hermes-state pin file exists on the host

#### Scenario: Disagreement-pass regression is hermetic

- **WHEN** a unit test injects an env pin of version `1.39.6` and a control pin of version `1.39.7` under factory-plane doctor
- **THEN** the pin-path check SHALL have status `"fail"`
- **AND** the same suite SHALL fail if that result is `"pass"`
- **AND** no real network, git, or subprocess call SHALL occur
