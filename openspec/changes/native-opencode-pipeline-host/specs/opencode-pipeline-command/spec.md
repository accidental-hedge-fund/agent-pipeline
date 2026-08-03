## ADDED Requirements

### Requirement: Installer SHALL install a native OpenCode /pipeline command

When `install --host opencode` runs (not dry-run), the installer SHALL write a
native OpenCode command definition at `<opencodeBase>/commands/pipeline.md`
(filename `pipeline.md` so OpenCode exposes `/pipeline`). The command SHALL
reference the absolute path of the OpenCode-managed skill launcher under the
same `opencodeBase` used for the skill tree. Dry-run SHALL NOT write the
command file.

#### Scenario: Install writes pipeline.md under OpenCode commands

- **WHEN** `install --host opencode` completes successfully (not dry-run)
- **THEN** `<opencodeBase>/commands/pipeline.md` SHALL exist
- **AND** its content SHALL reference the absolute launcher path under
  `<opencodeBase>/skills/pipeline`

#### Scenario: Config-dir install embeds config-dir launcher path

- **WHEN** `OPENCODE_CONFIG_DIR` is set to directory `D`
- **AND** `install --host opencode` runs (not dry-run)
- **THEN** `D/commands/pipeline.md` SHALL reference the launcher under
  `D/skills/pipeline`
- **AND** SHALL NOT use `<home>/.config/opencode/skills/pipeline` as the
  install target when `D` differs from that default

#### Scenario: Dry-run does not write the OpenCode command

- **WHEN** `install --host opencode --dry-run` runs
- **THEN** no `pipeline.md` SHALL be created or modified under the resolved
  OpenCode `commands/` directory

### Requirement: OpenCode /pipeline --version SHALL match the installed launcher version

The OpenCode `/pipeline` command path SHALL route `--version` and `-V` to the
installed pipeline launcher’s version short-circuit. The observable version
output SHALL equal the version printed by invoking that same launcher with
`--version` (and with `-V`), which SHALL equal the `version` field of
`core/package.json` at the OpenCode install root. The version path SHALL NOT
present generic pipeline instructional skill text (full skill usage dump) as
the response content for those invocations.

#### Scenario: /pipeline --version matches launcher --version

- **WHEN** OpenCode host is installed
- **AND** the operator invokes the OpenCode `/pipeline --version` command path
  (or the test double that exercises the same command→launcher routing)
- **THEN** the version string obtained SHALL equal the stdout of
  `node <opencode-skill>/pipeline.mjs --version` (trim trailing newline)
- **AND** SHALL equal the `version` field in
  `<opencode-skill>/core/package.json`

#### Scenario: /pipeline -V matches launcher -V

- **WHEN** OpenCode host is installed
- **AND** the operator invokes `/pipeline -V` via the same routing contract
- **THEN** the version string obtained SHALL equal the launcher’s `-V` output

#### Scenario: Version path does not dump skill instructions

- **WHEN** `/pipeline --version` is routed through the installed OpenCode
  command definition
- **THEN** the command definition used for that invocation SHALL NOT embed the
  full instructional SKILL.md body as the template content for the version path
- **AND** tests SHALL assert the version routing contract without requiring a
  live OpenCode TUI session

### Requirement: OpenCode /pipeline SHALL forward arguments without shell interpolation loss

The OpenCode `/pipeline` command SHALL forward ordinary pipeline arguments to
the installed launcher using an argv-preserving mechanism. The implementation
SHALL NOT build a shell command by unquoted concatenation of the raw argument
string (for example `node launcher $ARGUMENTS` under a shell that performs word
splitting or metacharacter expansion). Arguments that contain spaces or shell
metacharacters SHALL reach the launcher without loss or unintended expansion.

#### Scenario: Multi-token arguments reach the launcher intact

- **WHEN** the OpenCode `/pipeline` routing path is invoked with multiple
  discrete arguments (for example a subcommand and flags)
- **THEN** the launcher-facing argv SHALL preserve those tokens as separate
  arguments in order

#### Scenario: Arguments with spaces are not shell-split

- **WHEN** the routing path is exercised with an argument value that contains
  spaces (for example a quoted reason string)
- **THEN** that value SHALL arrive as a single argv element at the launcher
  boundary
- **AND** SHALL NOT be split on spaces by intermediate shell interpolation

#### Scenario: Shell metacharacters are not expanded

- **WHEN** the routing path is exercised with an argument containing shell
  metacharacters (for example `*` or `$HOME`)
- **THEN** the launcher-facing argv SHALL receive the literal characters
- **AND** SHALL NOT expand globs or perform shell parameter expansion on that
  argument

### Requirement: OpenCode command uninstall SHALL remove only installer-owned pipeline command files

When `uninstall --host opencode` runs, the installer SHALL remove
`<opencodeBase>/commands/pipeline.md` when present (installer-owned base
command) and SHALL NOT remove other command files in that directory.

#### Scenario: Uninstall removes pipeline.md and preserves siblings

- **WHEN** `<base>/commands/pipeline.md` and `<base>/commands/other.md` exist
- **AND** `uninstall --host opencode` runs (not dry-run)
- **THEN** `pipeline.md` SHALL be removed
- **AND** `other.md` SHALL remain
