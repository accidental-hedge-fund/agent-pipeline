# installer-command-lifecycle Specification

## Purpose
TBD - created by archiving change install-config-dir-commands-shadow-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Claude uninstall SHALL remove installer-written pipeline command files

When `uninstall --host claude` (or `--host all` including claude) runs, the installer SHALL remove the Claude skill tree as today **and** SHALL remove leftover namespaced command files matching `pipeline:*.md` under the resolved Claude config base’s `commands/` directory (the same base previously used by `installClaudeCommands`). Uninstall SHALL still do that cleanup even though install no longer writes those files. Uninstall SHALL NOT delete non-`pipeline:` command files in that directory. Dry-run SHALL report intended command-file removals without deleting them.

#### Scenario: Uninstall removes skill and pipeline commands under config dir

- **WHEN** `CLAUDE_CONFIG_DIR` is set to directory `D`
- **AND** a prior install left `D/skills/pipeline` and one or more leftover `D/commands/pipeline:*.md` files
- **AND** `uninstall --host claude` runs (not dry-run)
- **THEN** `D/skills/pipeline` SHALL no longer exist
- **AND** no `D/commands/pipeline:*.md` files SHALL remain

#### Scenario: Uninstall preserves unrelated command files

- **WHEN** the Claude `commands/` directory contains both leftover `pipeline:status.md` and an unrelated `other-tool.md`
- **AND** `uninstall --host claude` runs (not dry-run)
- **THEN** `pipeline:status.md` SHALL be removed
- **AND** `other-tool.md` SHALL still exist

#### Scenario: Uninstall with nothing installed is a no-op success

- **WHEN** neither the Claude skill directory nor any `pipeline:*.md` command files are present under the resolved base
- **AND** `uninstall --host claude` runs
- **THEN** the command SHALL complete without a non-zero exit solely due to their absence
- **AND** it SHALL NOT delete unrelated files under `commands/`

#### Scenario: Dry-run uninstall does not delete command files

- **WHEN** leftover `pipeline:*.md` files exist under the resolved Claude `commands/` directory
- **AND** `uninstall --host claude --dry-run` runs
- **THEN** those command files SHALL still exist after the run
- **AND** the dry-run output SHALL indicate they would be removed

### Requirement: Installer host lifecycle actions SHALL be driven by outer-host install profile data

Install, update, and uninstall actions that manage host skill trees and command surfaces SHALL
read managed artifact paths, install mode, and user-owned exclusion rules from the target host's
outer-host install/invocation profile (manifest/registry) rather than treating a closed
host-name switch as the only extension model for new hosts. Built-in hosts MAY keep equivalent
behavior by encoding today's paths and modes in their manifests.

Claude’s install profile SHALL NOT declare a managed `/pipeline:*` slash-command pack as a
required artifact. When a host profile’s command kind is none (or equivalent: no per-verb
command pack), install SHALL write the skill/CLI tree and SHALL NOT write `pipeline:*.md`.
Uninstall of leftover `pipeline:*.md` only, and dry-run no-write, remain in force.

#### Scenario: Managed command install uses profile-declared paths

- **WHEN** install runs for a registered host whose install profile declares a managed commands
  surface and skill tree
- **THEN** the installer SHALL write managed pipeline command/skill artifacts to the declared
  destinations
- **AND** a newly registered host with a complete install profile SHALL NOT require a new
  hard-coded host-name install function as the sole supported way to know those destinations

#### Scenario: Claude profile does not require a slash-command pack

- **WHEN** `install --host claude` runs (not dry-run)
- **THEN** the installer SHALL NOT write `pipeline:*.md` even if an older profile used
  `commandsKind` `claude-slash`
- **AND** it SHALL still provision the CLI skill tree at the profile-declared skill destination

#### Scenario: Uninstall still preserves non-managed files

- **WHEN** uninstall runs for a host whose install profile declares leftover `pipeline:*.md`
  (or equivalent) artifacts
- **AND** the commands directory also contains unrelated user files
- **THEN** only managed pipeline artifacts SHALL be removed
- **AND** unrelated user-owned files SHALL remain

