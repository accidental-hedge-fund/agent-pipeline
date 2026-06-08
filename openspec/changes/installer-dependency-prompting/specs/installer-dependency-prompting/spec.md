## ADDED Requirements

### Requirement: Dependency relevance filtering
The installer SHALL determine which external dependencies are relevant for the current install based on (a) which hosts are being installed and (b) feature flags in `.github/pipeline.yml`. It SHALL NOT prompt for dependencies that are not relevant to the chosen configuration.

Relevance rules:
- `cc-plugin-codex` (sendbird): relevant when the Claude Code host is being installed.
- `codex-plugin-cc` (openai): relevant when the Codex host is being installed.
- `openspec` CLI: relevant when `openspec.enabled: true` in `.github/pipeline.yml`, or when the file is absent and the user is setting up a new repo.
- `last30days` skill: relevant when `last30days.enabled: true` in `.github/pipeline.yml`.

#### Scenario: Claude-only install omits Codex companion
- **WHEN** the installer is run targeting only the Claude Code host
- **THEN** `codex-plugin-cc` is not included in the dependency prompt list

#### Scenario: Codex-only install omits Claude companion
- **WHEN** the installer is run targeting only the Codex host
- **THEN** `cc-plugin-codex` is not included in the dependency prompt list

#### Scenario: Feature flag gates last30days prompt
- **WHEN** `.github/pipeline.yml` exists and `last30days.enabled` is absent or false
- **THEN** the installer does not prompt for the `last30days` skill

#### Scenario: Feature flag enables last30days prompt
- **WHEN** `.github/pipeline.yml` has `last30days.enabled: true`
- **THEN** `last30days` is included in the dependency prompt list

### Requirement: Dependency detection
For each relevant dependency, the installer SHALL detect whether it is already installed and, if so, whether the installed version is current (latest).

#### Scenario: Companion plugin detected as present
- **WHEN** the relevant companion file exists in the expected plugin cache path
- **THEN** the installer records the dependency as present and proceeds to version comparison

#### Scenario: Companion plugin detected as absent
- **WHEN** the relevant companion file does not exist in the expected plugin cache path
- **THEN** the installer records the dependency as missing and marks it for the install prompt

#### Scenario: Version comparison succeeds
- **WHEN** the installed version can be read and the latest version can be fetched
- **THEN** the installer marks the dependency as `already current` if versions match, or `outdated` if they differ

#### Scenario: Version comparison fails
- **WHEN** the installed version cannot be determined or the network fetch fails
- **THEN** the installer treats the dependency as `unknown` and includes it in the install prompt with an `(version unknown)` annotation

### Requirement: Interactive dependency prompt
In interactive (TTY) mode, the installer SHALL prompt the user for each relevant dependency that is missing or outdated, one at a time. The prompt SHALL name the dependency, its source, and why it is needed.

#### Scenario: User accepts a missing dependency
- **WHEN** the installer prompts for a missing dependency and the user responds Y
- **THEN** the installer installs that dependency at its latest version

#### Scenario: User accepts an outdated dependency
- **WHEN** the installer prompts for an outdated dependency and the user responds Y
- **THEN** the installer updates that dependency to its latest version

#### Scenario: User declines a dependency
- **WHEN** the installer prompts for a dependency and the user responds N
- **THEN** the installer skips that dependency and records it as `declined`; the core install continues normally

#### Scenario: All dependencies are current
- **WHEN** all relevant dependencies are already installed at the latest version
- **THEN** the installer does not prompt for any of them and records each as `already current`

### Requirement: Non-interactive mode behaviour
When `process.stdin.isTTY` is falsy, the installer SHALL NOT present interactive dependency prompts. It SHALL instead skip all dependency installs and report which were skipped, unless `--yes-deps` or `PIPELINE_INSTALL_DEPS=1` is set.

#### Scenario: Non-interactive without opt-in skips all deps
- **WHEN** the installer runs without a TTY and without `--yes-deps` or `PIPELINE_INSTALL_DEPS=1`
- **THEN** all dependency prompts are skipped, each dep is recorded as `skipped`, and the output includes a hint to re-run with `--yes-deps`

#### Scenario: Non-interactive with --yes-deps auto-accepts all
- **WHEN** the installer runs without a TTY and `--yes-deps` is passed as a CLI flag
- **THEN** all relevant missing or outdated dependencies are installed without interactive prompts

#### Scenario: Non-interactive with env var auto-accepts all
- **WHEN** the installer runs without a TTY and `PIPELINE_INSTALL_DEPS=1` is set in the environment
- **THEN** all relevant missing or outdated dependencies are installed without interactive prompts

### Requirement: Failure isolation
A failure to install or update a dependency SHALL NOT prevent the core agent-pipeline skill install from completing, nor SHALL it abort installation of subsequent dependencies.

#### Scenario: Dependency install fails
- **WHEN** a dependency install command exits with a non-zero status or throws
- **THEN** the installer records the dependency as `failed`, logs the error output, and continues to the next dependency and the core install

#### Scenario: Core install completes despite dependency failure
- **WHEN** one or more dependencies record status `failed` or `declined`
- **THEN** the core skill files are placed and the installer exits successfully

### Requirement: Dependency status report
On completion, the installer SHALL print a per-dependency status summary covering every relevant dependency, regardless of its final state.

Status values: `installed`, `updated`, `already current`, `declined`, `failed`, `skipped`.

#### Scenario: Status table rendered after install
- **WHEN** the installer completes
- **THEN** it prints one status line per relevant dependency with its name and final status

#### Scenario: Failed dependency includes guidance
- **WHEN** a dependency has status `failed`
- **THEN** the status line includes the error summary and a manual install command the user can run

#### Scenario: Skipped dependencies include re-run hint
- **WHEN** one or more dependencies have status `skipped` (non-interactive mode)
- **THEN** the output includes a single hint line explaining how to install them (`--yes-deps` or `PIPELINE_INSTALL_DEPS=1`)

### Requirement: Base prerequisite warnings are unchanged
The existing preflight warnings for base CLIs (Node, git, gh, claude, codex, npm) SHALL remain as non-interactive warnings only. The installer SHALL NOT attempt to install or update these tools.

#### Scenario: Missing base CLI still warns only
- **WHEN** a base CLI (e.g., `gh`) is not on PATH during preflight
- **THEN** the installer emits a warning but does not prompt to install it, matching existing behaviour
