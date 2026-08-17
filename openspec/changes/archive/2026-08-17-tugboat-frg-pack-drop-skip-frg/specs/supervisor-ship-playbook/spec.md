## MODIFIED Requirements

### Requirement: Ship playbook engine-promote phase SHALL default install host to all

When the chain-to-existing-tools supervisor ship playbook reaches the engine-promote phase and the operator has not set `ENGINE_PROMOTE_HOST`, the playbook SHALL resolve the promote install host to `all` and SHALL invoke `pipeline engine-promote` with an explicit `--host all` (together with the existing promote flags such as `--for`). Default promote argv SHALL omit `--skip-frg`. The playbook SHALL NOT default `ENGINE_PROMOTE_HOST` or the promote `--host` argument to `codex` alone when the operator left the host unset.

#### Scenario: Unset ENGINE_PROMOTE_HOST yields --host all

- **WHEN** the ship playbook runs engine-promote for a published version
- **AND** `ENGINE_PROMOTE_HOST` is unset in the playbook environment
- **THEN** the playbook SHALL invoke engine-promote with `--host all`
- **AND** it SHALL NOT invoke engine-promote with `--host codex` solely because the environment variable was unset

#### Scenario: Playbook documentation matches the all default

- **WHEN** an operator reads the ship playbook environment documentation for `ENGINE_PROMOTE_HOST`
- **THEN** the documented default SHALL be `all` (not `codex`)

## ADDED Requirements

### Requirement: Ship playbook default release and promote argv SHALL omit skip-frg

The documented alternate chain playbook SHALL invoke `pipeline release` and `pipeline engine-promote` without `--skip-frg` on the default path. If the playbook remains installed, it SHALL compose the same `factory-release prepare` request/re-invoke sequence before release, or fail closed when release finds no Factory Reliability Gate (FRG) evidence. The playbook SHALL NOT keep hard-coded `--skip-frg` as its default and SHALL NOT add a grant factory or a second pack protocol.

#### Scenario: Default playbook release argv has no skip-frg

- **WHEN** the ship playbook enters release prepare
- **AND** no operator skip escape is active
- **THEN** the release invocation SHALL NOT include `--skip-frg`

#### Scenario: Default playbook promote argv has no skip-frg

- **WHEN** the ship playbook enters engine-promote
- **AND** no operator skip escape is active
- **THEN** the promote invocation SHALL NOT include `--skip-frg`

#### Scenario: Missing FRG fail-closes the alternate path

- **WHEN** the playbook reaches release and no `latest.json` `pass: true` exists for that version
- **AND** no operator skip escape is active
- **THEN** release SHALL fail closed
- **AND** the playbook SHALL NOT invent a pass or silently add `--skip-frg`
