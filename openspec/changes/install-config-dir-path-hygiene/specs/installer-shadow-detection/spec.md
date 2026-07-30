## ADDED Requirements

### Requirement: Detect personal skill before Codex install

The installer SHALL detect an unmanaged Codex personal skill before overwriting it. During `scripts/install.mjs install --host codex` (or `--host all` when codex is included), the installer SHALL check whether a pre-existing `<codexSkillsDir>/pipeline` directory exists that was NOT placed by this installer (i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a directory exists, the installer SHALL emit a non-blocking warning naming the collision and SHALL apply the same relocation offer / non-TTY auto-relocate / TTY-decline-skip semantics already required for Claude personal installs, using a backup base outside the Codex skills scan directory.

#### Scenario: Codex personal install present, no marker

- **WHEN** `<codexSkillsDir>/pipeline` exists
- **AND** `<codexSkillsDir>/pipeline/.pipeline-installer-managed` does NOT exist
- **THEN** a warning is emitted identifying the directory as an unmanaged personal install
- **AND** the installer does NOT abort or exit non-zero solely because of the warning

#### Scenario: Codex managed install present (subsequent update)

- **WHEN** `<codexSkillsDir>/pipeline` exists
- **AND** `<codexSkillsDir>/pipeline/.pipeline-installer-managed` EXISTS
- **THEN** no shadow warning is emitted for that host
- **AND** the installer proceeds with the normal overwrite for Codex

#### Scenario: No pre-existing Codex install

- **WHEN** `<codexSkillsDir>/pipeline` does NOT exist
- **THEN** no Codex shadow warning is emitted
- **AND** the installer proceeds normally for Codex

### Requirement: Codex marker file written on install

Successful Codex installs SHALL write the managed marker into the skill tree. When the installer successfully installs the skill for `--host codex`, it SHALL write an empty `.pipeline-installer-managed` sentinel file inside the installed skill directory (`<codexSkillsDir>/pipeline/.pipeline-installer-managed`). The file SHALL be written atomically as part of the staging step (before the `renameSync`) so it lands with the rest of the skill tree.

#### Scenario: Fresh Codex install writes marker

- **WHEN** `installHost("codex", false)` completes successfully
- **THEN** `<codexSkillsDir>/pipeline/.pipeline-installer-managed` exists in the installed tree

#### Scenario: Codex dry-run does not write marker

- **WHEN** `installHost("codex", true)` is called (dry-run mode)
- **THEN** no Codex skill files are written and no marker is created

### Requirement: Codex interactive relocation offer in TTY

The installer SHALL offer interactive relocation for a Codex personal install on a TTY. When a Codex personal install is detected AND `process.stdin.isTTY` is true, the installer SHALL prompt the user (Y/N) to relocate the pre-existing `<codexSkillsDir>/pipeline` to `<codexBase>/pipeline.<unique>.bak`, where `<codexBase>` is the parent directory of `<codexSkillsDir>` (honoring `CODEX_HOME` and the installer’s existing Codex base resolution). If the user confirms, the installer SHALL perform the relocation before installing. The relocation SHALL never overwrite an existing backup path. If the user declines, the installer SHALL leave the personal install untouched and SHALL skip this host’s install, print how to relocate later, and complete without a non-zero exit.

#### Scenario: User accepts Codex relocation

- **WHEN** a Codex personal install is detected in a TTY environment
- **AND** the user enters "y" or "Y" at the prompt
- **THEN** `<codexSkillsDir>/pipeline` is moved to a unique `<codexBase>/pipeline.<unique>.bak`
- **AND** the installer proceeds to install into the now-empty `<codexSkillsDir>/pipeline`

#### Scenario: User declines Codex relocation

- **WHEN** a Codex personal install is detected in a TTY environment
- **AND** the user enters "n" or "N" at the prompt (or presses Enter)
- **THEN** no relocation occurs and the personal install is left untouched
- **AND** the Codex host install is skipped
- **AND** the installer run completes without a non-zero exit

### Requirement: Codex non-interactive auto-relocation

The installer SHALL auto-relocate a Codex personal install in non-TTY environments. When a Codex personal install is detected AND `process.stdin.isTTY` is false, the installer SHALL skip the interactive prompt and SHALL auto-relocate the personal install to a unique `<codexBase>/pipeline.<unique>.bak` before proceeding with the install. It SHALL emit a warning naming the backup path so the move is not silent.

#### Scenario: Non-TTY environment, Codex personal install present

- **WHEN** a Codex personal install is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** no prompt is shown
- **AND** the personal install is moved to a unique `<codexBase>/pipeline.<unique>.bak`
- **AND** a warning is emitted naming the backup path
- **AND** the installer proceeds with the Codex install without user input

### Requirement: Paths honor CODEX_HOME for shadow detection

Codex shadow detection and relocation paths SHALL honor `CODEX_HOME`. All paths used by Codex detection and relocation SHALL be derived from the same Codex skills-directory resolution the installer already uses for install targets (`CODEX_HOME` when set; otherwise the existing `~/.codex` / `~/.agents` preference). No path SHALL be constructed by hardcoding `~/.codex` when `CODEX_HOME` is set.

#### Scenario: CODEX_HOME set

- **WHEN** `CODEX_HOME=/custom/codex` is set in the environment
- **AND** `install --host codex` is run
- **THEN** detection checks `/custom/codex/skills/pipeline` for the personal install
- **AND** relocation targets a unique path under `/custom/codex/pipeline.<unique>.bak`

#### Scenario: CODEX_HOME not set

- **WHEN** `CODEX_HOME` is not set
- **THEN** detection checks the installer’s resolved default Codex skills path for `pipeline`
- **AND** relocation targets a unique backup under the parent of that skills directory

### Requirement: Dry-run shadow handling is fully non-mutating

When `--dry-run` is set, personal-skill shadow handling for Claude and Codex SHALL warn and MAY report the intended unique backup path, but SHALL NOT relocate/rename an unmanaged skill, write `.pipeline-installer-managed`, or overwrite/write skill or command install files for that host.

#### Scenario: Dry-run with unmanaged Codex personal skill

- **WHEN** an unmanaged Codex personal skill exists at `<codexSkillsDir>/pipeline`
- **AND** `install --host codex --dry-run` is run
- **THEN** a shadow warning is emitted (optionally naming the intended backup path)
- **AND** the personal skill directory remains at its original path
- **AND** no `.pipeline-installer-managed` marker is created at the install target
- **AND** no Codex skill tree files are written under the install target
