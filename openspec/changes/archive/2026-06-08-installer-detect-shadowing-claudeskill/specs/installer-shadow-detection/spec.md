## ADDED Requirements

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
