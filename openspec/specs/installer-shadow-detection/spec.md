# installer-shadow-detection Specification

## Purpose
TBD - created by archiving change installer-detect-shadowing-claudeskill. Update Purpose after archive.

## Requirements

### Requirement: Detect personal skill before install
During `scripts/install.mjs install --host claude` (or `--host all` when claude is included), the installer SHALL check whether a pre-existing `<skillsDir>/pipeline` directory exists that was NOT placed by this installer (i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a directory exists, the installer SHALL emit a non-blocking warning naming the collision, explain the duplicate-`/pipeline` consequence, and offer to relocate the directory before proceeding.

#### Scenario: Personal install present, no marker
- **WHEN** `<claudeBase>/skills/pipeline` exists
- **AND** `<claudeBase>/skills/pipeline/.pipeline-installer-managed` does NOT exist
- **THEN** a warning is emitted identifying the directory as an unmanaged personal install
- **AND** the warning states that it will shadow or duplicate the plugin's `/pipeline` skill
- **AND** the installer does NOT abort or exit non-zero

#### Scenario: Managed install present (subsequent update)
- **WHEN** `<claudeBase>/skills/pipeline` exists
- **AND** `<claudeBase>/skills/pipeline/.pipeline-installer-managed` EXISTS
- **THEN** no shadow warning is emitted
- **AND** the installer proceeds with the normal overwrite

#### Scenario: No pre-existing install
- **WHEN** `<claudeBase>/skills/pipeline` does NOT exist
- **THEN** no shadow warning is emitted
- **AND** the installer proceeds normally

### Requirement: Marker file written on install
When the installer successfully installs the skill for `--host claude`, it SHALL write an empty `.pipeline-installer-managed` sentinel file inside the installed skill directory (`<skillsDir>/pipeline/.pipeline-installer-managed`). The file SHALL be written atomically as part of the staging step (before the `renameSync`) so it lands with the rest of the skill tree.

#### Scenario: Fresh install writes marker
- **WHEN** `installHost("claude", false)` completes successfully
- **THEN** `<skillsDir>/pipeline/.pipeline-installer-managed` exists in the installed tree
- **AND** the file is present inside the staging dir before the atomic rename

#### Scenario: Dry-run does not write marker
- **WHEN** `installHost("claude", true)` is called (dry-run mode)
- **THEN** no files are written and no marker is created

### Requirement: Interactive relocation offer in TTY
When a personal install is detected AND `process.stdin.isTTY` is true, the installer SHALL prompt the user (Y/N) to relocate the pre-existing `<skillsDir>/pipeline` to `<claudeBase>/pipeline.<unique>.bak`. If the user confirms, the installer SHALL perform the relocation before installing. The relocation SHALL never overwrite an existing backup path (SHALL find a unique name). If the user declines, the installer SHALL leave the personal install untouched and SHALL skip this host's install (because the install target is the same path — proceeding would overwrite the personal install, deleting data). It SHALL print the duplicate-`/pipeline` consequence and the exact command the user can run later to relocate manually, and the installer run SHALL complete without a non-zero exit.

#### Scenario: User accepts relocation
- **WHEN** personal install is detected in a TTY environment
- **AND** the user enters "y" or "Y" at the prompt
- **THEN** `<skillsDir>/pipeline` is moved to `<claudeBase>/pipeline.<unique>.bak`
- **AND** the moved path does NOT equal any already-existing path
- **AND** the installer proceeds to install into the now-empty `<skillsDir>/pipeline`

#### Scenario: User declines relocation
- **WHEN** personal install is detected in a TTY environment
- **AND** the user enters "n" or "N" at the prompt (or presses Enter)
- **THEN** no relocation occurs and the personal install is left untouched (no data deleted)
- **AND** this host's install is skipped (proceeding would overwrite the personal install at the same path)
- **AND** a message is printed stating the duplicate-`/pipeline` consequence (a personal install alongside the marketplace plugin)
- **AND** the exact shell command to relocate later is printed
- **AND** the installer run completes without a non-zero exit

#### Scenario: Backup path already exists, unique name chosen
- **WHEN** relocation is accepted
- **AND** `<claudeBase>/pipeline.<timestamp>.bak` already exists
- **THEN** the installer SHALL try `pipeline.<timestamp>.bak.1`, `.bak.2`, … until a unique name is found
- **AND** the relocation SHALL succeed without overwriting the existing backup
- **AND** the unique backup path SHALL be printed to the user

### Requirement: Non-interactive auto-relocation
When a personal install is detected AND `process.stdin.isTTY` is false (CI, piped execution), the installer SHALL skip the interactive prompt and, because the install target is the same path, SHALL auto-relocate the personal install to a unique `<claudeBase>/pipeline.<unique>.bak` (preserving data rather than overwriting it) before proceeding with the install. It SHALL emit a warning naming the backup path so the move is not silent.

#### Scenario: Non-TTY environment, personal install present
- **WHEN** personal install is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** no prompt is shown
- **AND** the personal install is moved to a unique `<claudeBase>/pipeline.<unique>.bak` (no data deleted, no existing backup overwritten)
- **AND** a warning is emitted naming the backup path
- **AND** the installer proceeds with the install without user input

### Requirement: Paths honor CLAUDE_CONFIG_DIR
All paths used by detection and relocation SHALL be derived from `claudeBase()` (which already honors `CLAUDE_CONFIG_DIR`). No path SHALL be constructed by hardcoding `~/.claude`.

#### Scenario: CLAUDE_CONFIG_DIR set
- **WHEN** `CLAUDE_CONFIG_DIR=/custom/dir` is set in the environment
- **AND** `install --host claude` is run
- **THEN** detection checks `/custom/dir/skills/pipeline` for the personal install
- **AND** relocation targets `/custom/dir/pipeline.<unique>.bak`

#### Scenario: CLAUDE_CONFIG_DIR not set
- **WHEN** `CLAUDE_CONFIG_DIR` is not set
- **THEN** detection checks `~/.claude/skills/pipeline`
- **AND** relocation targets `~/.claude/pipeline.<unique>.bak`

### Requirement: README references detection
The README "Claude Code — plugin marketplace" install section SHALL reference the installer's automatic detection and offer to help migrate existing personal installs, replacing the prose instruction to manually remove the old skill first.

#### Scenario: User reads README migration section
- **WHEN** a user reads the README plugin marketplace install section
- **THEN** they learn that the installer will detect and offer to relocate any pre-existing `~/.claude/skills/pipeline`
- **AND** they are NOT only instructed to manually remove the old skill without guidance

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

### Requirement: Detect personal OpenCode skill before install

The installer SHALL check, during `scripts/install.mjs install --host opencode`
(or `--host all` when opencode is included), whether a pre-existing OpenCode
`<skillsDir>/pipeline` directory exists that was NOT placed by this installer
(i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a
directory exists, the installer SHALL apply the same non-destructive shadow
handling used for Claude and Codex tree hosts: warn, and either offer
interactive relocation, auto-relocate in non-TTY environments, or skip the host
install when the operator declines relocation. The installer SHALL NOT silently
overwrite an unmanaged personal OpenCode skill directory.

#### Scenario: Personal OpenCode install present, no marker

- **WHEN** the resolved OpenCode skills path contains a `pipeline` directory
- **AND** that directory has no `.pipeline-installer-managed` marker
- **AND** `install --host opencode` runs
- **THEN** the installer SHALL treat the directory as an unmanaged personal
  install
- **AND** SHALL NOT overwrite it without relocation or an explicit skip of this
  host’s install
- **AND** the installer SHALL NOT exit non-zero solely because a personal
  install was detected

#### Scenario: Managed OpenCode install present (subsequent update)

- **WHEN** the resolved OpenCode `skills/pipeline` directory exists
- **AND** it contains `.pipeline-installer-managed`
- **AND** `install --host opencode` or `update --host opencode` runs
- **THEN** no personal-shadow relocation offer is required
- **AND** the installer proceeds with the normal managed overwrite

#### Scenario: No pre-existing OpenCode install

- **WHEN** the resolved OpenCode `skills/pipeline` path does not exist
- **AND** `install --host opencode` runs
- **THEN** no shadow warning is required for OpenCode
- **AND** the installer proceeds with a normal install into that path

### Requirement: OpenCode shadow relocation SHALL preserve data under the OpenCode base

The installer SHALL move a personal OpenCode skill, when relocated, to a unique
backup path under the OpenCode base directory that owns the skills path
(`OPENCODE_CONFIG_DIR` when set, otherwise `<home>/.config/opencode`). The
relocation SHALL never overwrite an existing backup path. Interactive TTY
accept/decline and non-TTY auto-relocate semantics SHALL match the Claude
personal-install policy (accept → relocate then install; decline → leave
personal tree untouched and skip this host; non-TTY → auto-relocate then
install with a warning naming the backup).

#### Scenario: TTY user accepts OpenCode relocation

- **WHEN** a personal OpenCode skill is detected in a TTY environment
- **AND** the user confirms relocation
- **THEN** the personal `pipeline` directory is moved to a unique
  `pipeline.<unique>.bak` path under the OpenCode base
- **AND** the installer proceeds to install into the now-empty OpenCode skills
  `pipeline` path

#### Scenario: TTY user declines OpenCode relocation

- **WHEN** a personal OpenCode skill is detected in a TTY environment
- **AND** the user declines relocation
- **THEN** the personal tree SHALL remain untouched
- **AND** this host’s install SHALL be skipped
- **AND** the installer run SHALL complete without a non-zero exit solely due to
  the skip

#### Scenario: Non-TTY auto-relocates OpenCode personal skill

- **WHEN** a personal OpenCode skill is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** the personal install is moved to a unique backup under the OpenCode
  base
- **AND** a warning names the backup path
- **AND** the installer proceeds with the managed install

### Requirement: Detect personal OMP skill before install

The installer SHALL check, during `scripts/install.mjs install --host omp` (or `--host all` when omp is included), whether a pre-existing OMP `<skillsDir>/pipeline` directory exists that was NOT placed by this installer (i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a directory exists, the installer SHALL apply the same non-destructive shadow handling used for Claude, Codex, and OpenCode tree hosts: warn, and either offer interactive relocation, auto-relocate in non-TTY environments, or skip the host install when the operator declines relocation. The installer SHALL NOT silently overwrite an unmanaged personal OMP skill directory.

#### Scenario: Personal OMP install present, no marker

- **WHEN** the resolved OMP skills path contains a `pipeline` directory
- **AND** that directory has no `.pipeline-installer-managed` marker
- **AND** `install --host omp` runs
- **THEN** the installer SHALL treat the directory as an unmanaged personal install
- **AND** SHALL NOT overwrite it without relocation or an explicit skip of this host’s install
- **AND** the installer SHALL NOT exit non-zero solely because a personal install was detected

#### Scenario: Managed OMP install present (subsequent update)

- **WHEN** the resolved OMP `skills/pipeline` directory exists
- **AND** it contains `.pipeline-installer-managed`
- **AND** `install --host omp` or `update --host omp` runs
- **THEN** no personal-shadow relocation offer is required
- **AND** the installer proceeds with the normal managed overwrite

#### Scenario: No pre-existing OMP install

- **WHEN** the resolved OMP `skills/pipeline` path does not exist
- **AND** `install --host omp` runs
- **THEN** no shadow warning is required for OMP
- **AND** the installer proceeds with a normal install into that path

### Requirement: OMP shadow relocation SHALL preserve data under the OMP agent root

The installer SHALL move a personal OMP skill, when relocated, to a unique backup path under `<home>/.omp/agent`. The relocation SHALL never overwrite an existing backup path. Interactive TTY accept/decline and non-TTY auto-relocate semantics SHALL match the Claude personal-install policy (accept → relocate then install; decline → leave personal tree untouched and skip this host; non-TTY → auto-relocate then install with a warning naming the backup).

#### Scenario: TTY user accepts OMP relocation

- **WHEN** a personal OMP skill is detected in a TTY environment
- **AND** the user confirms relocation
- **THEN** the personal `pipeline` directory is moved to a unique `pipeline.<unique>.bak` path under `<home>/.omp/agent`
- **AND** the installer proceeds to install into the now-empty OMP skills `pipeline` path

#### Scenario: TTY user declines OMP relocation

- **WHEN** a personal OMP skill is detected in a TTY environment
- **AND** the user declines relocation
- **THEN** the personal tree SHALL remain untouched
- **AND** this host’s install SHALL be skipped
- **AND** the installer run SHALL complete without a non-zero exit solely due to the skip

#### Scenario: Non-TTY auto-relocates OMP personal skill

- **WHEN** a personal OMP skill is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** the personal install is moved to a unique backup under `<home>/.omp/agent`
- **AND** the installer proceeds with the managed install
- **AND** the warning SHALL name the backup path
