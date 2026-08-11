## ADDED Requirements

### Requirement: Ship playbook engine-promote phase SHALL default install host to all

When the chain-to-existing-tools supervisor ship playbook reaches the engine-promote phase and the operator has not set `ENGINE_PROMOTE_HOST`, the playbook SHALL resolve the promote install host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with the existing promote flags such as `--for` and thin-ship FRG skip). The playbook SHALL NOT default `ENGINE_PROMOTE_HOST` or the promote `--host` argument to `codex` alone when the operator left the host unset.

#### Scenario: Unset ENGINE_PROMOTE_HOST yields --host all

- **WHEN** the ship playbook runs engine-promote for a published version
- **AND** `ENGINE_PROMOTE_HOST` is unset in the playbook environment
- **THEN** the playbook SHALL invoke engine-promote with `--host all`
- **AND** it SHALL NOT invoke engine-promote with `--host codex` solely because the environment variable was unset

#### Scenario: Playbook documentation matches the all default

- **WHEN** an operator reads the ship playbook environment documentation for `ENGINE_PROMOTE_HOST`
- **THEN** the documented default SHALL be `all` (not `codex`)

### Requirement: Ship playbook engine-promote phase SHALL honor ENGINE_PROMOTE_HOST override

When the operator sets `ENGINE_PROMOTE_HOST` to a single valid install host (`codex`, `claude`, `grok`, or `opencode`) or to `all`, the ship playbook SHALL pass that exact value as `--host` to `pipeline engine-promote` and SHALL NOT replace a single-host override with `all`.

#### Scenario: ENGINE_PROMOTE_HOST=codex scopes playbook promote

- **WHEN** the ship playbook runs engine-promote
- **AND** `ENGINE_PROMOTE_HOST` is set to `codex`
- **THEN** the playbook SHALL invoke engine-promote with `--host codex`
- **AND** it SHALL NOT rewrite the host to `all`

#### Scenario: ENGINE_PROMOTE_HOST=claude scopes playbook promote

- **WHEN** the ship playbook runs engine-promote
- **AND** `ENGINE_PROMOTE_HOST` is set to `claude`
- **THEN** the playbook SHALL invoke engine-promote with `--host claude`

### Requirement: Ship playbook promote host default SHALL be regression-tested

The ship playbook's default promote host resolution (unset → `all`, set → override) SHALL be covered by an automated check (script fixture, static assertion against the playbook source default, or extracted pure helper) that fails if the unset default reverts to `codex`.

#### Scenario: Regression fails if playbook default reverts to codex

- **WHEN** the automated check for ship playbook promote host resolution runs against a playbook whose unset default is `codex`
- **THEN** the check SHALL fail
- **AND** the same check SHALL pass when the unset default is `all` and an explicit override is still honored
