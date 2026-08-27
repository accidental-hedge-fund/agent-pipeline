## MODIFIED Requirements

### Requirement: Engine-promote install host SHALL default to all configured hosts

When `pipeline engine-promote` runs without an explicit `--host` value, or when the promote stage is invoked without a host option, the effective install host selector SHALL be `all`. The promote path SHALL pass that selector to the tag install as an explicit `--host all` (or equivalent argv) so the installer updates every host tree it supports under `all` (including Codex, Claude, Grok when applicable, OpenCode, and OMP, honoring configured base dirs such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `OPENCODE_CONFIG_DIR`; OMP uses the global `~/.omp/agent` root). The promote path SHALL NOT silently default the install host to `codex` alone.

#### Scenario: Bare promote without --host installs with host all

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z` without `--host`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host all`
- **AND** it SHALL NOT use `--host codex` solely because the host option was omitted

#### Scenario: Stage invoke without host option resolves to all

- **WHEN** the engine-promote stage runs with no host option set
- **AND** install is not skipped
- **THEN** the resolved install host selector SHALL be `all`
- **AND** operator-visible promote logging or the recorded install command SHALL name that host value

### Requirement: Engine-promote SHALL honor an explicit single-host override

When the operator supplies a valid single-host `--host` value (`codex`, `claude`, `grok`, `opencode`, or `omp`), the promote path SHALL install only for that host and SHALL NOT expand the install to `all`. Invalid host values SHALL fail closed before install mutation.

#### Scenario: Explicit --host codex stays scoped

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z --host codex`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host codex`
- **AND** it SHALL NOT rewrite the host selector to `all`

#### Scenario: Explicit --host claude stays scoped

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z --host claude`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host claude`

#### Scenario: Explicit --host omp stays scoped

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z --host omp`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host omp`
- **AND** it SHALL NOT rewrite the host selector to `all`
