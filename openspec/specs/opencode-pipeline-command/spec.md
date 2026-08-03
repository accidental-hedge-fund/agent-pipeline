# opencode-pipeline-command Specification

## Purpose
TBD - created by archiving change native-opencode-pipeline-host. Update Purpose after archive.
## Requirements
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

### Requirement: OpenCode /pipeline command surface SHALL be explicitly LLM-mediated

The OpenCode `/pipeline` command surface SHALL be an LLM-mediated markdown
prompt template: when `/pipeline` is invoked, OpenCode expands the template
(including any shell-injection results) and sends that content as a prompt turn
to the LLM. The installer SHALL install a markdown command that uses shell
injection (`!`…``) so the installed bridge/launcher runs and its stdout is
injected into that prompt. The installer SHALL NOT claim a pure no-LLM /
direct-process-stdout host integration that OpenCode does not provide. Tests
SHALL exercise the command→bridge→launcher routing contract without requiring a
live OpenCode TUI session and SHALL NOT assert that OpenCode returns process
stdout without an LLM turn.

#### Scenario: Command definition uses shell inject plus agent instruction

- **WHEN** `install --host opencode` writes `commands/pipeline.md`
- **THEN** the file SHALL contain a shell-injection block that invokes the
  installed argv-safe bridge with the absolute skill-tree path
- **AND** SHALL contain instruction text telling the agent to treat the inject
  output as the authoritative launcher result for version-style invocations
- **AND** SHALL NOT present the command as a pure side-effect CLI that bypasses
  OpenCode’s prompt turn

#### Scenario: Host-contract tests do not claim no-LLM stdout return

- **WHEN** regression tests cover the OpenCode `/pipeline` version path
- **THEN** they SHALL prove bridge/launcher stdout equality and template
  content constraints
- **AND** SHALL NOT require or claim a live OpenCode host return of process
  stdout without an LLM turn

### Requirement: OpenCode /pipeline --version inject SHALL match the installed launcher version

The OpenCode `/pipeline --version` and `/pipeline -V` path SHALL run the
installed pipeline launcher’s version short-circuit via the command template’s
shell-injection path and argv-safe bridge. The stdout produced by that injection
SHALL equal the version printed by invoking that same launcher with `--version`
(and with `-V`), which SHALL equal the `version` field of `core/package.json` at
the OpenCode install root. The command template SHALL instruct the host agent to
report only that injected version string for those invocations and SHALL NOT
embed the full instructional SKILL.md body as template content. Residual
presentation through OpenCode’s LLM session is acknowledged; the guaranteed
contract is deterministic inject + instruction, not a host-level non-LLM stdout
short-circuit.

#### Scenario: /pipeline --version inject matches launcher --version

- **WHEN** OpenCode host is installed
- **AND** the operator invokes the OpenCode `/pipeline --version` command path
  (or the test double that exercises the same command→bridge→launcher routing)
- **THEN** the version string obtained from the bridge/launcher inject path
  SHALL equal the stdout of `node <opencode-skill>/pipeline.mjs --version`
  (trim trailing newline)
- **AND** SHALL equal the `version` field in
  `<opencode-skill>/core/package.json`

#### Scenario: /pipeline -V inject matches launcher -V

- **WHEN** OpenCode host is installed
- **AND** the operator invokes `/pipeline -V` via the same routing contract
- **THEN** the version string obtained from the inject path SHALL equal the
  launcher’s `-V` output

#### Scenario: Version path does not dump skill instructions

- **WHEN** `/pipeline --version` is routed through the installed OpenCode
  command definition
- **THEN** the command definition used for that invocation SHALL NOT embed the
  full instructional SKILL.md body as the template content for the version path
- **AND** tests SHALL assert the inject/bridge version routing contract without
  requiring a live OpenCode TUI session

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

