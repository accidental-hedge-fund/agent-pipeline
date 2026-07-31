## ADDED Requirements

### Requirement: Install-time Claude command files embed the resolved skill path

Install-time Claude command generation SHALL pass the resolved absolute skill directory path into `renderClaudeCommand`. When `scripts/install.mjs` installs the Claude host, each written `<claudeBase>/commands/pipeline:<name>.md` file SHALL be produced by calling `renderClaudeCommand(op, skillPath)` where `skillPath` is `<claudeBase>/skills/pipeline`, with `claudeBase` derived from `CLAUDE_CONFIG_DIR` when set and from the user home `~/.claude` otherwise. The installer SHALL NOT hardcode the string `~/.claude/skills/pipeline` as `skillPath` for personal install command generation. Command filenames SHALL be generated from `OPERATION_SURFACE` only (no second name list).

#### Scenario: CLAUDE_CONFIG_DIR set — command body points at config-dir skill

- **WHEN** `CLAUDE_CONFIG_DIR=/custom/dir` is set in the environment
- **AND** `install --host claude` completes successfully (non-dry-run)
- **THEN** each file `/custom/dir/commands/pipeline:<name>.md` for every operation in `OPERATION_SURFACE` SHALL exist
- **AND** the command body SHALL reference `/custom/dir/skills/pipeline` (as the skill path prefix for the Invoke / `node …/scripts/pipeline.mjs` line)
- **AND** the command body SHALL NOT reference `~/.claude/skills/pipeline` as the skill path prefix

#### Scenario: CLAUDE_CONFIG_DIR unset — default home skill path

- **WHEN** `CLAUDE_CONFIG_DIR` is not set
- **AND** `install --host claude` completes successfully (non-dry-run)
- **THEN** each file under `~/.claude/commands/pipeline:<name>.md` (or the absolute home-equivalent path) SHALL exist for every operation in `OPERATION_SURFACE`
- **AND** the command body SHALL reference the resolved default skill directory under the user home `.claude/skills/pipeline` (absolute form is acceptable)

#### Scenario: Dry-run does not write command files

- **WHEN** `install --host claude --dry-run` is run
- **THEN** no `pipeline:<name>.md` files SHALL be created or overwritten under the Claude commands directory

### Requirement: Install-time Claude command Invoke paths are shell-safe

The installer SHALL emit shell-safe skill/script paths in Claude command Invoke lines. When `renderClaudeCommand` embeds the absolute skill directory (or the full path to `scripts/pipeline.mjs`) into a `` `node …` `` invocation, that path SHALL be quoted or escaped so that spaces and other shell-significant characters in `CLAUDE_CONFIG_DIR` do not split or reinterpret the path token.

#### Scenario: Config dir path contains a space

- **WHEN** `CLAUDE_CONFIG_DIR` resolves to a path containing a space (e.g. `/tmp/my claude`)
- **AND** `install --host claude` completes successfully (non-dry-run)
- **THEN** each `pipeline:<name>.md` Invoke line SHALL include a quoted/escaped form of the skill or script path under that directory
- **AND** the unquoted path fragment SHALL NOT appear as a bare space-split token in the `node …/pipeline.mjs` invocation
