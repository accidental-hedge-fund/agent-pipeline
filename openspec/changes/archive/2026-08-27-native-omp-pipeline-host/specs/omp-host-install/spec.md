## Purpose

First-class installer host for OMP (Oh My Pi): global `~/.omp/agent` skill tree, overlay, outer-host manifest, and install lifecycle isolated from other hosts and from project `.omp` directories.

## ADDED Requirements

### Requirement: Installer SHALL accept OMP as a first-class host target

The installer SHALL accept `omp` as a valid `--host` value alongside `claude`, `codex`, `grok`, `opencode`, and `all`. Usage header comments and unknown-`--host` error text SHALL list `omp` among implemented hosts. Selecting `--host omp` SHALL install or update only the OMP host surfaces defined by this capability.

#### Scenario: --host omp is accepted

- **WHEN** an operator runs `node scripts/install.mjs install --host omp`
- **THEN** the installer SHALL NOT reject `omp` as an unknown host
- **AND** SHALL perform the OMP install path (or dry-run report of that path)

#### Scenario: Unknown host error lists omp

- **WHEN** an operator runs the installer with an unsupported `--host` value
- **THEN** the error message SHALL list `omp` among valid host names

#### Scenario: Usage header documents omp

- **WHEN** an operator reads the installer usage header
- **THEN** the documented `--host` set SHALL include `omp`
- **AND** every host name listed SHALL be accepted by the installer

### Requirement: OMP install base SHALL be the global OMP agent root only

The OMP install base SHALL be `<home>/.omp/agent`. The skill tree SHALL be installed at `<home>/.omp/agent/skills/pipeline`. The installer SHALL NOT treat a project `<cwd>/.omp` directory as an install base. The installer SHALL NOT write named OMP profile agent directories (`<home>/.omp/profiles/<name>/agent`). The installer SHALL NOT relocate the base via an environment variable.

#### Scenario: Default install lands under ~/.omp/agent

- **WHEN** `install --host omp` runs (not dry-run)
- **THEN** a managed skill tree SHALL exist at `<home>/.omp/agent/skills/pipeline`

#### Scenario: Project .omp is not installer-managed

- **WHEN** `<cwd>/.omp` exists
- **AND** `install --host omp` runs (not dry-run)
- **THEN** the installer SHALL NOT create or modify skill or command files under `<cwd>/.omp`

#### Scenario: Named OMP profile dirs are not installer-managed

- **WHEN** `<home>/.omp/profiles/<name>/agent` exists
- **AND** `install --host omp` runs (not dry-run)
- **THEN** the installer SHALL NOT write skill or command files under that profile agent directory

#### Scenario: Dry-run writes no OMP skill tree

- **WHEN** `install --host omp --dry-run` runs
- **THEN** no files SHALL be created or modified under `<home>/.omp/agent/skills/pipeline`

### Requirement: OMP host install SHALL materialize core, overlay, launcher, manifest, and managed marker

`install --host omp` (tree mode) SHALL stage the shared `core/` tree, the `hosts/omp` overlay, and the shared launcher shim into the OMP skill directory, SHALL write `hosts/omp/outer-host.manifest.json` in the repository host overlay, and SHALL write the `.pipeline-installer-managed` sentinel in the installed tree. Forced `--host omp` SHALL create `<home>/.omp/agent` when that directory is missing.

#### Scenario: Fresh OMP install produces a managed skill tree

- **WHEN** no skill exists at `<home>/.omp/agent/skills/pipeline`
- **AND** `install --host omp` completes successfully (not dry-run)
- **THEN** that path SHALL contain the shared core, an OMP host SKILL.md (or equivalent overlay entry), a launcher entry, and `.pipeline-installer-managed`

#### Scenario: Repository overlay includes the OMP outer-host manifest

- **WHEN** this change is implemented
- **THEN** `hosts/omp/outer-host.manifest.json` SHALL exist
- **AND** its `id` SHALL be `omp`

#### Scenario: Forced omp install creates a missing agent root

- **WHEN** `<home>/.omp/agent` does not exist
- **AND** `install --host omp` runs (not dry-run)
- **THEN** the installer SHALL create that base as needed for the skill tree
- **AND** SHALL complete the OMP install

#### Scenario: OMP install does not modify other hosts

- **WHEN** `install --host omp` runs
- **THEN** the installer SHALL NOT create, update, or delete Claude, Codex, Grok, or OpenCode skill or command artifacts as part of that host selection

### Requirement: OMP update and uninstall SHALL touch only installer-owned OMP artifacts

`update --host omp` SHALL refresh the OMP managed skill tree and installer-owned OMP pipeline command artifacts. `uninstall --host omp` SHALL remove the OMP managed skill tree and installer-owned OMP pipeline command artifacts under `<home>/.omp/agent`, and SHALL NOT delete unrelated files under OMP commands or any Claude/Codex/Grok/OpenCode install. Uninstall of a missing OMP install SHALL succeed without non-zero exit solely due to absence. Dry-run uninstall SHALL report removals without deleting.

#### Scenario: Uninstall removes OMP skill and pipeline command only

- **WHEN** a prior OMP install wrote `<home>/.omp/agent/skills/pipeline` and the installer-owned OMP `/pipeline` command artifact
- **AND** an unrelated command artifact exists under `<home>/.omp/agent/commands/`
- **AND** `uninstall --host omp` runs (not dry-run)
- **THEN** `<home>/.omp/agent/skills/pipeline` SHALL no longer exist
- **AND** the installer-owned OMP `/pipeline` command artifact SHALL no longer exist
- **AND** the unrelated command artifact SHALL still exist

#### Scenario: Uninstall leaves other hosts intact

- **WHEN** Claude, Codex, Grok, and OpenCode managed installs exist
- **AND** `uninstall --host omp` runs
- **THEN** those installs SHALL remain

#### Scenario: Dry-run uninstall does not delete OMP artifacts

- **WHEN** installer-owned OMP skill and command artifacts exist
- **AND** `uninstall --host omp --dry-run` runs
- **THEN** those artifacts SHALL still exist after the run
- **AND** dry-run output SHALL indicate they would be removed

### Requirement: Outer-host id omp SHALL remain distinct from adapter id pi

The pipeline SHALL register `omp` as an outer-host id and SHALL keep `pi` as a harness-adapter id. Install host selection, outer-host registry enumeration, and discovery that names outer hosts SHALL use `omp`. Stage-adapter dispatch SHALL continue to resolve `pi` as the Pi Coding Agent adapter. The pipeline SHALL NOT treat `pi` as an alias of `omp` or `omp` as an alias of `pi`.

#### Scenario: Install host omp does not register adapter pi as a host

- **WHEN** an operator runs install with `--host pi`
- **THEN** the installer SHALL reject `pi` as an unknown outer host (unless a later change adds a distinct host of that id)
- **AND** SHALL NOT perform the OMP install path because the token was `pi`

#### Scenario: Adapter pi remains resolvable after OMP ships

- **WHEN** the harness-adapter registry is inspected after OMP is a builtin outer host
- **THEN** adapter `pi` SHALL still resolve
- **AND** outer-host registry id `omp` SHALL be present
- **AND** those two ids SHALL NOT be equal

### Requirement: An omp profile SHALL be bootstrap metadata only

When an `omp` pipeline profile is shipped, it SHALL provide launcher and presentation defaults only. Live implementer and reviewer for a runnable repository SHALL come from `.github/pipeline.yml`. The profile SHALL NOT name a new harness adapter `omp`. The profile SHALL NOT select live stage workers.

#### Scenario: OMP-launched execution uses repository harness roles

- **WHEN** `.github/pipeline.yml` sets `harnesses.implementer` and `harnesses.reviewer`
- **AND** configuration is resolved under the `omp` profile
- **THEN** the live implementer and reviewer SHALL equal those repository keys
- **AND** the profile SHALL NOT override either live role

#### Scenario: omp profile does not invent an omp adapter

- **WHEN** `core/profiles/omp.json` exists
- **THEN** its `harnesses.implementer` and `harnesses.reviewer` SHALL each name an already registered harness adapter
- **AND** neither value SHALL be the string `omp`

### Requirement: --host all SHALL include omp when the OMP agent base exists

When `--host all` selects present tree hosts, `omp` SHALL be included when `<home>/.omp/agent` exists. `omp` SHALL appear in the valid-host set regardless of that detection.

#### Scenario: all includes omp when the agent root exists

- **WHEN** `<home>/.omp/agent` exists
- **AND** `install --host all` runs
- **THEN** the selected host set SHALL include `omp`

#### Scenario: all remains valid when omp base is absent

- **WHEN** `<home>/.omp/agent` does not exist
- **AND** another registered host base exists
- **AND** `install --host all` runs
- **THEN** the installer SHALL still run for the detected hosts
- **AND** `omp` SHALL remain a valid explicit `--host` value

### Requirement: README SHALL document OMP as a supported host

The project README SHALL document `install --host omp`, the default skill and command locations under `~/.omp/agent`, that project `.omp` is not installer-managed, and that `/pipeline` is the native OMP command surface.

#### Scenario: Operator can install OMP from README alone

- **WHEN** an operator follows only the README install section for OMP
- **THEN** they SHALL have the install command, host name `omp`, and the default install locations needed to locate the skill and `/pipeline` command
