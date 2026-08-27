# engine-promote Specification

## Purpose
Defines self-host engine promote after a published release: pin promotion plus tag install host selection so every configured outer-host skill tree receives the released engine unless the operator scopes the install.

## Requirements

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

### Requirement: Engine-promote SHALL require FRG unless the resolved skip is active

The live `pipeline engine-promote` path SHALL require Factory Reliability Gate (FRG) evidence for the target version unless the shared skip resolution is active: explicit CLI `--skip-frg`, or else `.github/pipeline.yml` `skip_frg: true` when the flag is absent. Unset or `skip_frg: false` SHALL leave FRG required. When only the yml key causes the skip, the skip log SHALL name config. Config SHALL NOT force FRG on if the operator passed `--skip-frg`.

A successful **non-skip** promote SHALL write a production-quality pin: `frg_run_id` SHALL equal the FRG evidence `run_id` and SHALL NOT start with `no-frg-`, and `frg_evidence_path` SHALL be non-null. When skip is active, the path MAY write a clearly marked non-production-quality pin (`frg_run_id` `no-frg-<X.Y.Z>`, `frg_evidence_path` null). Default promote SHALL fail closed instead of writing that marker.

When the live pin is already at the target version and tag, engine-promote SHALL treat that pin as already-current success only if the pin is production-quality, or if the resolved skip is active. A same-version `no-frg-*` / null-evidence pin SHALL NOT count as already-current success on the default path. Default promote SHALL then refuse, or re-promote from a real FRG pass for that version.

#### Scenario: Unset or false still requires FRG without the flag

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` without `--skip-frg`
- **AND** no FRG pass artifact for `X.Y.Z` is available
- **THEN** the command SHALL fail closed and SHALL NOT promote the pin as a successful unblocked completion

#### Scenario: Config skip_frg true skips FRG without the flag

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` without `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
- **AND** the skip log SHALL name config as the source
- **AND** a written pin SHALL be marked non-production-quality (`no-frg-X.Y.Z`, null evidence)

#### Scenario: CLI --skip-frg still skips when skip_frg is unset or false

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the operator runs `pipeline engine-promote --for X.Y.Z` with `--skip-frg`
- **THEN** the command SHALL skip the FRG requirement
- **AND** a written pin SHALL be marked non-production-quality (`no-frg-X.Y.Z`, null evidence)

#### Scenario: Non-skip success writes real FRG fields

- **WHEN** the operator runs `pipeline engine-promote --for 1.37.0` without resolved skip
- **AND** FRG evidence for `1.37.0` exists with `pass: true` and `run_id` `frg-abc`
- **THEN** the written pin SHALL set `frg_run_id` to `frg-abc`
- **AND** SHALL set `frg_evidence_path` to a non-null path
- **AND** SHALL NOT set `frg_run_id` to `no-frg-1.37.0`

#### Scenario: Same-version no-frg pin is not already-current success

- **WHEN** the live pin already names version `1.37.0` and tag `v1.37.0`
- **AND** that pin has `frg_run_id` `no-frg-1.37.0` or `frg_evidence_path` null
- **AND** the operator runs `pipeline engine-promote --for 1.37.0` without resolved skip
- **THEN** the command SHALL NOT treat the pin as already-current success
- **AND** it SHALL refuse, or re-promote from a real FRG pass for `1.37.0`

### Requirement: Non-skip engine-promote SHALL write the exported factory pin

A successful non-skip `pipeline engine-promote` SHALL write the production-quality pin
to `AGENT_PIPELINE_PRODUCTION_PIN` when that path is set (including when factory ship
exported the default factory pin file). The command SHALL NOT update only
`<repoDir>/.agent-pipeline/production-engine-pin.json` when `repoDir` is a worktree (or
other directory) that is not the exported pin's directory.

Default promote (no resolved skip) SHALL NOT write `frg_run_id` `no-frg-<X.Y.Z>` or a
null `frg_evidence_path`. A unit test SHALL fail if that default write is reintroduced.

#### Scenario: Promote with exported pin path updates that file

- **WHEN** `AGENT_PIPELINE_PRODUCTION_PIN` is `/factory/.agent-pipeline/production-engine-pin.json`
- **AND** promote `repoDir` is `/worktrees/pipeline-promote`
- **AND** non-skip `pipeline engine-promote --for 1.39.3` succeeds from FRG evidence
  with `run_id` `frg-abc` and `pass: true`
- **THEN** `/factory/.agent-pipeline/production-engine-pin.json` SHALL contain
  `version` `1.39.3` and `frg_run_id` `frg-abc`
- **AND** SHALL contain a non-null `frg_evidence_path`
- **AND** SHALL NOT set `frg_run_id` to `no-frg-1.39.3`

#### Scenario: Default promote test fails on no-frg write

- **WHEN** unit tests invoke non-skip promote with injected FRG lookup returning a
  real pass
- **THEN** the written pin SHALL NOT have `frg_run_id` starting with `no-frg-`
- **AND** the same suite SHALL fail if default promote writes `no-frg-<version>`
  without explicit skip
- **AND** no real network, git, or subprocess call SHALL occur

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

#### Scenario: Managed worktree factory-pin promote writes the control-checkout pin

- **WHEN** `pipeline factory-pin promote` succeeds from a managed worktree of the live factory control checkout
- **AND** factory-plane `REPO_DIR` is that checkout
- **AND** `AGENT_PIPELINE_PRODUCTION_PIN` is unset
- **THEN** the written pin SHALL be `$REPO_DIR/.agent-pipeline/production-engine-pin.json`
- **AND** SHALL NOT write `<worktree>/.agent-pipeline/production-engine-pin.json`

#### Scenario: Skip-frg marker is not clone law

- **WHEN** `--skip-frg` writes a pin with `frg_run_id` `no-frg-X.Y.Z`
- **AND** a later `pipeline doctor` or `pipeline train` runs in a non-control clone that still contains that marker file
- **AND** two-track policy is inactive on that clone
- **THEN** `install:engine-track` SHALL NOT fail solely for that marker
- **AND** `--skip-frg` SHALL remain a valid operator escape that writes a non-production marker
