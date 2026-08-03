## ADDED Requirements

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
