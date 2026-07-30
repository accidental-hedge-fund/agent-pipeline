## ADDED Requirements

### Requirement: Claude uninstall removes installer-written command files

Claude uninstall SHALL remove installer-written `pipeline:<name>.md` command files in addition to the skill directory. When `scripts/install.mjs uninstall --host claude` (or `--host all` when claude is included) runs, the uninstaller SHALL remove each `<claudeBase>/commands/pipeline:<name>.md` file corresponding to an operation in `OPERATION_SURFACE`, in addition to removing the skill directory `<claudeBase>/skills/pipeline` when present. Paths SHALL honor `CLAUDE_CONFIG_DIR` via the same `claudeBase` resolution used at install time. Missing individual command files SHALL NOT cause a non-zero exit (idempotent cleanup). Command cleanup SHALL run independently of skill-directory presence: the uninstaller MUST NOT return early solely because the skill directory is absent.

#### Scenario: Uninstall after full Claude install

- **WHEN** a prior non-dry-run Claude install has written the skill tree and `pipeline:<name>.md` command files under `<claudeBase>`
- **AND** `uninstall --host claude` is run (non-dry-run)
- **THEN** `<claudeBase>/skills/pipeline` SHALL no longer exist
- **AND** every `<claudeBase>/commands/pipeline:<name>.md` for operations in `OPERATION_SURFACE` SHALL no longer exist

#### Scenario: Uninstall with CLAUDE_CONFIG_DIR set

- **WHEN** `CLAUDE_CONFIG_DIR=/custom/dir` is set
- **AND** command files exist under `/custom/dir/commands/pipeline:*.md` for `OPERATION_SURFACE` operations
- **AND** `uninstall --host claude` is run (non-dry-run)
- **THEN** those `/custom/dir/commands/pipeline:<name>.md` files SHALL be removed
- **AND** the uninstaller SHALL NOT require files under `~/.claude/commands/`

#### Scenario: Uninstall when skill dir already absent

- **WHEN** the Claude skill directory is already absent
- **AND** installer-written `pipeline:<name>.md` files still exist under `<claudeBase>/commands/`
- **AND** `uninstall --host claude` is run (non-dry-run)
- **THEN** those command files SHALL still be removed
- **AND** the uninstall SHALL complete without a non-zero exit
- **AND** the uninstaller SHALL NOT skip command cleanup because the skill directory was missing

### Requirement: Claude uninstall preserves non-pipeline command files

Claude uninstall SHALL NOT remove non-pipeline command files. Uninstall of the Claude host SHALL only delete command files named `pipeline:<name>.md` for operations in `OPERATION_SURFACE`. It SHALL NOT delete other files under `<claudeBase>/commands/` (user-authored or third-party command markdown).

#### Scenario: Unrelated command file preserved

- **WHEN** `<claudeBase>/commands/my-other-tool.md` exists
- **AND** `uninstall --host claude` is run (non-dry-run)
- **THEN** `my-other-tool.md` SHALL still exist after uninstall

### Requirement: Dry-run uninstall does not delete Claude command files

Dry-run Claude uninstall SHALL report command-file removal without deleting files. When `uninstall --host claude --dry-run` is run, the uninstaller SHALL report that it would remove the installer-written `pipeline:<name>.md` command files (and the skill directory if present) and SHALL NOT delete any of those paths.

#### Scenario: Dry-run leaves commands intact

- **WHEN** installer-written `pipeline:<name>.md` files exist under `<claudeBase>/commands/`
- **AND** `uninstall --host claude --dry-run` is run
- **THEN** those command files SHALL still exist after the dry-run
- **AND** the dry-run output SHALL indicate that command-file removal would occur
