# installer-command-lifecycle Specification

## Purpose
TBD - created by archiving change install-config-dir-commands-shadow-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Claude command files SHALL embed the resolved skill path under CLAUDE_CONFIG_DIR

When the installer writes Claude namespaced command files (`pipeline:<name>.md` under `<claudeBase>/commands/`), each file’s invoke path to the pipeline skill SHALL use the skill directory that the installer actually installed (or would install) for that host base — i.e. `<claudeBase>/skills/pipeline` where `claudeBase` is `CLAUDE_CONFIG_DIR` when set, otherwise the default Claude config home. The installer SHALL NOT hardcode `~/.claude/skills/pipeline` (or an absolute path under the user’s default `~/.claude`) when `CLAUDE_CONFIG_DIR` points elsewhere.

#### Scenario: Config-dir install embeds config-dir skill path

- **WHEN** `CLAUDE_CONFIG_DIR` is set to a non-default directory `D`
- **AND** `install --host claude` runs (not dry-run)
- **THEN** every written `D/commands/pipeline:*.md` file SHALL reference the skill under `D/skills/pipeline` in its invoke line
- **AND** those files SHALL NOT contain a skill path of `~/.claude/skills/pipeline` as the install target

#### Scenario: Default install still targets default skill location

- **WHEN** `CLAUDE_CONFIG_DIR` is unset
- **AND** `install --host claude` runs (not dry-run)
- **THEN** every written command file under the default Claude `commands/` directory SHALL reference the default Claude skill location (`~/.claude/skills/pipeline` or the absolute equivalent of that same directory)

#### Scenario: Dry-run does not write command files

- **WHEN** `install --host claude --dry-run` runs
- **THEN** no `pipeline:*.md` files are created or modified under the Claude `commands/` directory

### Requirement: Claude uninstall SHALL remove installer-written pipeline command files

When `uninstall --host claude` (or `--host all` including claude) runs, the installer SHALL remove the Claude skill tree as today **and** SHALL remove namespaced command files matching `pipeline:*.md` under the resolved Claude config base’s `commands/` directory (the same base `installClaudeCommands` used). Uninstall SHALL NOT delete non-`pipeline:` command files in that directory. Dry-run SHALL report intended command-file removals without deleting them.

#### Scenario: Uninstall removes skill and pipeline commands under config dir

- **WHEN** `CLAUDE_CONFIG_DIR` is set to directory `D`
- **AND** a prior install wrote `D/skills/pipeline` and one or more `D/commands/pipeline:*.md` files
- **AND** `uninstall --host claude` runs (not dry-run)
- **THEN** `D/skills/pipeline` SHALL no longer exist
- **AND** no `D/commands/pipeline:*.md` files SHALL remain

#### Scenario: Uninstall preserves unrelated command files

- **WHEN** the Claude `commands/` directory contains both `pipeline:status.md` and an unrelated `other-tool.md`
- **AND** `uninstall --host claude` runs (not dry-run)
- **THEN** `pipeline:status.md` SHALL be removed
- **AND** `other-tool.md` SHALL still exist

#### Scenario: Uninstall with nothing installed is a no-op success

- **WHEN** neither the Claude skill directory nor any `pipeline:*.md` command files are present under the resolved base
- **AND** `uninstall --host claude` runs
- **THEN** the command SHALL complete without a non-zero exit solely due to their absence
- **AND** it SHALL NOT delete unrelated files under `commands/`

#### Scenario: Dry-run uninstall does not delete command files

- **WHEN** installer-written `pipeline:*.md` files exist under the resolved Claude `commands/` directory
- **AND** `uninstall --host claude --dry-run` runs
- **THEN** those command files SHALL still exist after the run
- **AND** the dry-run output SHALL indicate they would be removed

### Requirement: Installer host lifecycle actions SHALL be driven by outer-host install profile data

Install, update, and uninstall actions that manage host skill trees and command surfaces SHALL
read managed artifact paths, install mode, and user-owned exclusion rules from the target host's
outer-host install/invocation profile (manifest/registry) rather than treating a closed
host-name switch as the only extension model for new hosts. Built-in hosts MAY keep equivalent
behavior by encoding today's paths and modes in their manifests.

Existing host-specific requirements (Claude config-dir command embedding, uninstall of
`pipeline:*.md` only, dry-run no-write) remain in force; this requirement adds the
manifest-driven extension boundary.

#### Scenario: Managed command install uses profile-declared paths

- **WHEN** install runs for a registered host whose install profile declares a managed commands
  surface and skill tree
- **THEN** the installer SHALL write managed pipeline command/skill artifacts to the declared
  destinations
- **AND** a newly registered host with a complete install profile SHALL NOT require a new
  hard-coded host-name install function as the sole supported way to know those destinations

#### Scenario: Uninstall still preserves non-managed files

- **WHEN** uninstall runs for a host whose install profile declares managed `pipeline:*.md`
  (or equivalent) artifacts
- **AND** the commands directory also contains unrelated user files
- **THEN** only managed pipeline artifacts SHALL be removed
- **AND** unrelated user-owned files SHALL remain

