# opencode-host-install Specification

## Purpose
TBD - created by archiving change native-opencode-pipeline-host. Update Purpose after archive.
## Requirements
### Requirement: Installer SHALL accept OpenCode as a first-class host target

The installer SHALL accept `opencode` as a valid `--host` value alongside
`claude`, `codex`, `grok`, and `all`. Usage header comments and unknown-`--host`
error text SHALL list `opencode` among implemented hosts. Selecting
`--host opencode` SHALL install or update only the OpenCode host surfaces
defined by this capability.

#### Scenario: --host opencode is accepted

- **WHEN** an operator runs `node scripts/install.mjs install --host opencode`
- **THEN** the installer SHALL NOT reject `opencode` as an unknown host
- **AND** SHALL perform the OpenCode install path (or dry-run report of that path)

#### Scenario: Unknown host error lists opencode

- **WHEN** an operator runs the installer with an unsupported `--host` value
- **THEN** the error message SHALL list `opencode` among valid host names

#### Scenario: Usage header documents opencode

- **WHEN** an operator reads the installer usage header
- **THEN** the documented `--host` set SHALL include `opencode`
- **AND** every host name listed SHALL be accepted by the installer

### Requirement: OpenCode install base SHALL resolve under the OpenCode config directory

The OpenCode install base SHALL be `OPENCODE_CONFIG_DIR` when that environment
variable is set to a non-empty path; otherwise it SHALL be
`<home>/.config/opencode`. The skill tree SHALL be installed at
`<opencodeBase>/skills/pipeline`. The installer SHALL NOT hardcode
`~/.config/opencode` when `OPENCODE_CONFIG_DIR` points elsewhere. The
single-file override `OPENCODE_CONFIG` SHALL NOT be treated as the install base.

#### Scenario: Default install lands under ~/.config/opencode

- **WHEN** `OPENCODE_CONFIG_DIR` is unset
- **AND** `install --host opencode` runs (not dry-run)
- **THEN** a managed skill tree SHALL exist at
  `<home>/.config/opencode/skills/pipeline`

#### Scenario: OPENCODE_CONFIG_DIR relocates the skill tree

- **WHEN** `OPENCODE_CONFIG_DIR` is set to a non-default directory `D`
- **AND** `install --host opencode` runs (not dry-run)
- **THEN** a managed skill tree SHALL exist at `D/skills/pipeline`
- **AND** the installer SHALL NOT require a skill tree under
  `<home>/.config/opencode/skills/pipeline` for that run

#### Scenario: Dry-run writes no OpenCode skill tree

- **WHEN** `install --host opencode --dry-run` runs
- **THEN** no files SHALL be created or modified under the resolved OpenCode
  skills directory

### Requirement: OpenCode host install SHALL materialize core, overlay, launcher, and managed marker

`install --host opencode` (tree mode) SHALL stage the shared `core/` tree, the
`hosts/opencode` overlay, and the shared launcher shim into the OpenCode skill
directory, and SHALL write the `.pipeline-installer-managed` sentinel in that
tree. The launcher SHALL be bound to the OpenCode profile so OpenCode is the
default implementer for that install.

#### Scenario: Fresh OpenCode install produces a managed skill tree

- **WHEN** no skill exists at the OpenCode skills `pipeline` path
- **AND** `install --host opencode` completes successfully (not dry-run)
- **THEN** `<opencodeBase>/skills/pipeline` SHALL contain the shared core, an
  OpenCode host SKILL.md (or equivalent overlay entry), a launcher entry, and
  `.pipeline-installer-managed`

#### Scenario: OpenCode install does not modify Claude or Codex

- **WHEN** `install --host opencode` runs
- **THEN** the installer SHALL NOT create, update, or delete Claude skill,
  Claude command, Codex skill, or Codex agent artifacts as part of that host
  selection

### Requirement: OpenCode update and uninstall SHALL touch only installer-owned OpenCode artifacts

`update --host opencode` SHALL refresh the OpenCode managed skill tree and
installer-owned OpenCode pipeline command file(s). `uninstall --host opencode`
SHALL remove the OpenCode managed skill tree and installer-owned OpenCode
pipeline command file(s) under the resolved OpenCode base, and SHALL NOT delete
unrelated files under OpenCode `commands/` or any Claude/Codex/Grok install.
Uninstall of a missing OpenCode install SHALL succeed without non-zero exit
solely due to absence. Dry-run uninstall SHALL report removals without deleting.

#### Scenario: Uninstall removes OpenCode skill and pipeline command only

- **WHEN** a prior OpenCode install wrote `<base>/skills/pipeline` and
  `<base>/commands/pipeline.md`
- **AND** an unrelated `<base>/commands/other.md` exists
- **AND** `uninstall --host opencode` runs (not dry-run)
- **THEN** `<base>/skills/pipeline` SHALL no longer exist
- **AND** `<base>/commands/pipeline.md` SHALL no longer exist
- **AND** `<base>/commands/other.md` SHALL still exist

#### Scenario: Uninstall leaves Claude and Codex intact

- **WHEN** Claude and Codex managed installs exist
- **AND** `uninstall --host opencode` runs
- **THEN** those Claude and Codex installs SHALL remain

#### Scenario: Dry-run uninstall does not delete OpenCode artifacts

- **WHEN** installer-owned OpenCode skill and `pipeline.md` command exist
- **AND** `uninstall --host opencode --dry-run` runs
- **THEN** those artifacts SHALL still exist after the run
- **AND** dry-run output SHALL indicate they would be removed

#### Scenario: Update refreshes managed OpenCode tree

- **WHEN** a managed OpenCode skill tree already exists
- **AND** `update --host opencode` runs (not dry-run)
- **THEN** the tree SHALL remain managed (marker present)
- **AND** the install SHALL complete without treating the managed tree as a
  personal shadow conflict

### Requirement: README SHALL document OpenCode as a supported host

The project README SHALL document `install --host opencode`, the default skill
and command locations under the OpenCode config base, and that
`OPENCODE_CONFIG_DIR` relocates those paths when set.

#### Scenario: Operator can install OpenCode from README alone

- **WHEN** an operator follows only the README install section for OpenCode
- **THEN** they SHALL have the install command, host name `opencode`, and the
  default install locations needed to locate the skill and `/pipeline` command

