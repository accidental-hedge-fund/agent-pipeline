## ADDED Requirements

### Requirement: Detect personal Codex skill before install

During `scripts/install.mjs install --host codex` (or `--host all` when codex is included), the installer SHALL check whether a pre-existing Codex `<skillsDir>/pipeline` directory exists that was NOT placed by this installer (i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a directory exists, the installer SHALL apply the same non-destructive shadow handling used for Claude: warn, and either offer interactive relocation, auto-relocate in non-TTY environments, or skip the host install when the operator declines relocation. The installer SHALL NOT silently overwrite an unmanaged personal Codex skill directory.

#### Scenario: Personal Codex install present, no marker

- **WHEN** the resolved Codex skills path contains a `pipeline` directory
- **AND** that directory has no `.pipeline-installer-managed` marker
- **AND** `install --host codex` runs
- **THEN** the installer SHALL treat the directory as an unmanaged personal install
- **AND** SHALL NOT overwrite it without relocation or an explicit skip of this host’s install
- **AND** the installer SHALL NOT exit non-zero solely because a personal install was detected

#### Scenario: Managed Codex install present (subsequent update)

- **WHEN** the resolved Codex `skills/pipeline` directory exists
- **AND** it contains `.pipeline-installer-managed`
- **AND** `install --host codex` runs
- **THEN** no personal-shadow relocation offer is required
- **AND** the installer proceeds with the normal managed overwrite

#### Scenario: No pre-existing Codex install

- **WHEN** the resolved Codex `skills/pipeline` path does not exist
- **AND** `install --host codex` runs
- **THEN** no shadow warning is required for Codex
- **AND** the installer proceeds with a normal install into that path

### Requirement: Codex shadow relocation SHALL preserve data under the Codex base

When a personal Codex skill is relocated, the installer SHALL move it to a unique backup path under the Codex base directory that owns the skills path (the parent of the resolved skills directory: `CODEX_HOME` when set, otherwise the discovered `~/.codex` or `~/.agents` home used by skills resolution). The relocation SHALL never overwrite an existing backup path. Interactive TTY accept/decline and non-TTY auto-relocate semantics SHALL match the Claude personal-install policy (accept → relocate then install; decline → leave personal tree untouched and skip this host; non-TTY → auto-relocate then install with a warning naming the backup).

#### Scenario: TTY user accepts Codex relocation

- **WHEN** a personal Codex skill is detected in a TTY environment
- **AND** the user confirms relocation
- **THEN** the personal `pipeline` directory is moved to a unique `pipeline.<unique>.bak` path under the Codex base
- **AND** the installer proceeds to install into the now-empty Codex skills `pipeline` path

#### Scenario: TTY user declines Codex relocation

- **WHEN** a personal Codex skill is detected in a TTY environment
- **AND** the user declines relocation
- **THEN** the personal install is left untouched
- **AND** the Codex host install is skipped
- **AND** the installer run completes without a non-zero exit solely due to the decline

#### Scenario: Non-TTY auto-relocates Codex personal install

- **WHEN** a personal Codex skill is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** no interactive prompt is shown
- **AND** the personal install is moved to a unique backup under the Codex base
- **AND** a warning names the backup path
- **AND** the installer proceeds with the Codex install

### Requirement: Codex detection and relocation paths honor CODEX_HOME

All Codex paths used by personal-skill detection and relocation SHALL be derived from the same skills-dir resolution the installer already uses for Codex installs (honoring `CODEX_HOME` when set). No Codex path SHALL be constructed by hardcoding only `~/.codex` when `CODEX_HOME` points elsewhere.

#### Scenario: CODEX_HOME set

- **WHEN** `CODEX_HOME=/custom/codex` is set in the environment
- **AND** `install --host codex` runs against a personal install at `/custom/codex/skills/pipeline` without the managed marker
- **THEN** detection checks `/custom/codex/skills/pipeline`
- **AND** relocation targets a unique backup under `/custom/codex` (not under the operator’s default `~/.codex` unless that is the resolved base)

#### Scenario: CODEX_HOME not set

- **WHEN** `CODEX_HOME` is not set
- **AND** the installer resolves Codex skills via its normal discovery rules
- **THEN** detection and relocation use that same resolved skills directory and its parent base

### Requirement: Tree-mode hosts SHALL share the shadow gate

The install loop SHALL run personal-skill shadow detection for every selected **tree-mode** host that installs into `<skillsDir>/pipeline` with the managed-marker contract (at minimum Claude and Codex). Symlink-only hosts (Grok) are not required to use this tree overwrite/relocation gate. The shadow gate SHALL NOT remain Claude-exclusive while Codex tree installs can overwrite unmanaged personal trees.

#### Scenario: --host all runs shadow checks for both Claude and Codex

- **WHEN** `install --host all` is invoked
- **AND** both Claude and Codex host targets are included
- **THEN** an unmanaged personal skill at either host’s `skills/pipeline` path SHALL trigger that host’s shadow handling before that host’s install writes
- **AND** a managed marker at either path SHALL allow normal managed overwrite for that host

#### Scenario: Claude-only install does not require Codex shadow work

- **WHEN** `install --host claude` is invoked and Codex is not selected
- **THEN** the installer is not required to inspect or relocate any Codex skill path during that run
