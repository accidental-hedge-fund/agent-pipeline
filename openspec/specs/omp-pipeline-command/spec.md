# omp-pipeline-command Specification

## Purpose
Native non-LLM TypeScript `/pipeline` command for OMP that execs the installed launcher with captured `process.execPath` and forwards session cwd plus exact argv, without loading the OpenCode markdown template.

## Requirements

### Requirement: Installer SHALL install a native non-LLM OMP /pipeline command

When `install --host omp` runs (not dry-run), the installer SHALL write a native OMP TypeScript custom command that OMP exposes as `/pipeline`. The command SHALL invoke the installed launcher as a process and SHALL NOT expand into an LLM prompt template. Dry-run SHALL NOT write the command artifact.

#### Scenario: Install writes the OMP TypeScript /pipeline command

- **WHEN** `install --host omp` completes successfully (not dry-run)
- **THEN** a TypeScript custom command named `pipeline` SHALL exist under `<home>/.omp/agent/commands/`
- **AND** that command SHALL be the OMP `/pipeline` surface

#### Scenario: Dry-run does not write the OMP command

- **WHEN** `install --host omp --dry-run` runs
- **THEN** no OMP `/pipeline` command artifact SHALL be created or modified under `<home>/.omp/agent/commands/`

### Requirement: OMP /pipeline SHALL exec the captured installer Node and the installed launcher

The generated OMP `/pipeline` command SHALL start the installed `scripts/pipeline.mjs` using the absolute `process.execPath` captured when `install.mjs` ran. The spawn SHALL use a discrete argv array. The command SHALL NOT invoke PATH `node`. The command SHALL NOT use a shell to interpolate user arguments. The command SHALL NOT require `~/.local/bin/pipeline`.

#### Scenario: Generated command embeds absolute execPath and launcher path

- **WHEN** `install --host omp` writes the OMP `/pipeline` command
- **THEN** the command SHALL contain the absolute install-time `process.execPath`
- **AND** SHALL contain the absolute path to the installed `scripts/pipeline.mjs` under `<home>/.omp/agent/skills/pipeline`
- **AND** SHALL NOT contain a bare PATH `node` invocation as the launcher executable

#### Scenario: Spawn is not a shell string

- **WHEN** the installed OMP `/pipeline` command runs with arguments
- **THEN** the launcher process SHALL be started without `sh -c` concatenation of user arguments
- **AND** user arguments SHALL appear as discrete argv elements after the launcher path

### Requirement: OMP /pipeline SHALL forward session cwd and exact argv

The OMP `/pipeline` command SHALL set the launcher process working directory to the OMP session working directory. The command SHALL forward the operator's argument tokens to the launcher in order, including subcommands and flags. Arguments that contain spaces or shell metacharacters SHALL reach the launcher without loss or unintended expansion.

#### Scenario: train argv reaches the launcher

- **WHEN** an OMP session invokes `/pipeline train --milestone data-integrity`
- **THEN** the launcher-facing argv SHALL include `train`, `--milestone`, and `data-integrity` in that order

#### Scenario: Session working directory is forwarded

- **WHEN** the OMP session working directory is directory `D`
- **AND** `/pipeline` is invoked
- **THEN** the launcher process cwd SHALL be `D`

#### Scenario: Arguments with spaces are not split

- **WHEN** the routing path is exercised with an argument value that contains spaces
- **THEN** that value SHALL arrive as a single argv element at the launcher boundary

#### Scenario: Shell metacharacters are not expanded

- **WHEN** the routing path is exercised with an argument containing shell metacharacters (for example `*` or `$HOME`)
- **THEN** the launcher-facing argv SHALL receive the literal characters
- **AND** SHALL NOT expand globs or perform shell parameter expansion on that argument

### Requirement: OMP /pipeline SHALL NOT load the OpenCode command template

The OMP `/pipeline` surface SHALL NOT be `~/.config/opencode/commands/pipeline.md`. After `install --host omp`, an OMP `/pipeline` invocation SHALL execute the installer-owned OMP TypeScript command even when that OpenCode markdown file exists. The installer SHALL NOT write OpenCode `pipeline.md` as the OMP command.

#### Scenario: OpenCode pipeline.md is not the OMP surface

- **WHEN** `~/.config/opencode/commands/pipeline.md` exists
- **AND** `install --host omp` has completed
- **AND** an OMP session invokes `/pipeline --version`
- **THEN** the invoked command SHALL be the installer-owned OMP TypeScript command
- **AND** SHALL NOT load `~/.config/opencode/commands/pipeline.md` as the command definition

#### Scenario: Install does not write OpenCode pipeline.md for OMP

- **WHEN** `install --host omp` runs
- **THEN** the installer SHALL NOT create or update `~/.config/opencode/commands/pipeline.md` as part of that host selection

### Requirement: OMP /pipeline --version SHALL match the installed launcher version

The OMP `/pipeline --version` and `/pipeline -V` path SHALL run the installed pipeline launcher version short-circuit. The version string obtained from that path SHALL equal the stdout of invoking that same launcher with `--version` (and with `-V`), which SHALL equal the `version` field of `core/package.json` at the OMP install root. Tests SHALL exercise the command→launcher routing contract without requiring a live OMP TUI session.

#### Scenario: /pipeline --version matches launcher --version

- **WHEN** OMP host is installed
- **AND** the operator invokes the OMP `/pipeline --version` command path (or the test double that exercises the same command→launcher routing)
- **THEN** the version string SHALL equal the stdout of the captured execPath running the installed `scripts/pipeline.mjs --version` (trim trailing newline)
- **AND** SHALL equal the `version` field in `<omp-skill>/core/package.json`

#### Scenario: /pipeline -V matches launcher -V

- **WHEN** OMP host is installed
- **AND** the operator invokes `/pipeline -V` via the same routing contract
- **THEN** the version string SHALL equal the launcher’s `-V` output

### Requirement: OMP command uninstall SHALL remove only the installer-owned pipeline command

When `uninstall --host omp` runs, the installer SHALL remove the installer-owned OMP `/pipeline` TypeScript command artifact when present and SHALL NOT remove other command files under `<home>/.omp/agent/commands/`.

#### Scenario: Uninstall removes pipeline command and preserves siblings

- **WHEN** the installer-owned OMP `/pipeline` command and an unrelated command artifact exist under `<home>/.omp/agent/commands/`
- **AND** `uninstall --host omp` runs (not dry-run)
- **THEN** the `/pipeline` command artifact SHALL be removed
- **AND** the unrelated command artifact SHALL remain
