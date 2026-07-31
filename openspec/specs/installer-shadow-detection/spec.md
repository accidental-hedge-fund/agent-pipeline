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

