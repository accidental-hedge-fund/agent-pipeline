## Purpose

Defines self-host engine promote after a published release: pin promotion plus tag install host selection so every configured outer-host skill tree receives the released engine unless the operator scopes the install.

## ADDED Requirements

### Requirement: Engine-promote install host SHALL default to all configured hosts

When `pipeline engine-promote` runs without an explicit `--host` value, or when the promote stage is invoked without a host option, the effective install host selector SHALL be `all`. The promote path SHALL pass that selector to the tag install as an explicit `--host all` (or equivalent argv) so the installer updates every host tree it supports under `all` (including Codex, Claude, Grok when applicable, and OpenCode, honoring configured base dirs such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `OPENCODE_CONFIG_DIR`). The promote path SHALL NOT silently default the install host to `codex` alone.

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

When the operator supplies a valid single-host `--host` value (`codex`, `claude`, `grok`, or `opencode`), the promote path SHALL install only for that host and SHALL NOT expand the install to `all`. Invalid host values SHALL fail closed before install mutation.

#### Scenario: Explicit --host codex stays scoped

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z --host codex`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host codex`
- **AND** it SHALL NOT rewrite the host selector to `all`

#### Scenario: Explicit --host claude stays scoped

- **WHEN** an operator runs `pipeline engine-promote --for X.Y.Z --host claude`
- **AND** install is not skipped
- **THEN** the promote install command SHALL include `--host claude`

### Requirement: Effective promote host SHALL be visible in promote output

The promote path SHALL record the effective host selector in the install command string used for dry-run and live install, and SHALL include that host in operator-visible step logging when install runs or would run. Silent omission of the host flag (relying on an undocumented installer default) is not sufficient for the promote surface.

#### Scenario: Dry-run names the resolved host in the would-install command

- **WHEN** `pipeline engine-promote --for X.Y.Z --dry-run` runs without `--host`
- **THEN** the would-install command recorded in the result SHALL include `--host all`

#### Scenario: Live install log names the host

- **WHEN** promote runs a non-dry-run install with resolved host `all`
- **THEN** promote logging SHALL include the host value `all` (for example in an install progress line that names `host=all`)

### Requirement: Host resolution defaults SHALL be unit-testable without network or real skill trees

Host default and override resolution for engine-promote SHALL be covered by unit tests that inject no real network, git, or host skill-tree mutation. At least one test SHALL fail if the omitted-host default reverts to `codex` alone, and at least one test SHALL prove an explicit host override is preserved in the install command.

#### Scenario: Omitted host default regression fails on codex-only revert

- **WHEN** unit tests exercise install-command or host resolution for promote without a host option
- **THEN** the expected default host selector SHALL be `all`
- **AND** the test suite SHALL fail if that default is `codex` without an explicit operator host

#### Scenario: Override regression preserves single host

- **WHEN** unit tests exercise promote with host `claude` (or another single host)
- **THEN** the install command under test SHALL contain `--host claude` (or that host)
- **AND** it SHALL NOT expand to `--host all`
