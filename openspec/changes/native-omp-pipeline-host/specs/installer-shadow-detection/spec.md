## ADDED Requirements

### Requirement: Detect personal OMP skill before install

The installer SHALL check, during `scripts/install.mjs install --host omp` (or `--host all` when omp is included), whether a pre-existing OMP `<skillsDir>/pipeline` directory exists that was NOT placed by this installer (i.e., lacks the `.pipeline-installer-managed` sentinel file). If such a directory exists, the installer SHALL apply the same non-destructive shadow handling used for Claude, Codex, and OpenCode tree hosts: warn, and either offer interactive relocation, auto-relocate in non-TTY environments, or skip the host install when the operator declines relocation. The installer SHALL NOT silently overwrite an unmanaged personal OMP skill directory.

#### Scenario: Personal OMP install present, no marker

- **WHEN** the resolved OMP skills path contains a `pipeline` directory
- **AND** that directory has no `.pipeline-installer-managed` marker
- **AND** `install --host omp` runs
- **THEN** the installer SHALL treat the directory as an unmanaged personal install
- **AND** SHALL NOT overwrite it without relocation or an explicit skip of this host’s install
- **AND** the installer SHALL NOT exit non-zero solely because a personal install was detected

#### Scenario: Managed OMP install present (subsequent update)

- **WHEN** the resolved OMP `skills/pipeline` directory exists
- **AND** it contains `.pipeline-installer-managed`
- **AND** `install --host omp` or `update --host omp` runs
- **THEN** no personal-shadow relocation offer is required
- **AND** the installer proceeds with the normal managed overwrite

#### Scenario: No pre-existing OMP install

- **WHEN** the resolved OMP `skills/pipeline` path does not exist
- **AND** `install --host omp` runs
- **THEN** no shadow warning is required for OMP
- **AND** the installer proceeds with a normal install into that path

### Requirement: OMP shadow relocation SHALL preserve data under the OMP agent root

The installer SHALL move a personal OMP skill, when relocated, to a unique backup path under `<home>/.omp/agent`. The relocation SHALL never overwrite an existing backup path. Interactive TTY accept/decline and non-TTY auto-relocate semantics SHALL match the Claude personal-install policy (accept → relocate then install; decline → leave personal tree untouched and skip this host; non-TTY → auto-relocate then install with a warning naming the backup).

#### Scenario: TTY user accepts OMP relocation

- **WHEN** a personal OMP skill is detected in a TTY environment
- **AND** the user confirms relocation
- **THEN** the personal `pipeline` directory is moved to a unique `pipeline.<unique>.bak` path under `<home>/.omp/agent`
- **AND** the installer proceeds to install into the now-empty OMP skills `pipeline` path

#### Scenario: TTY user declines OMP relocation

- **WHEN** a personal OMP skill is detected in a TTY environment
- **AND** the user declines relocation
- **THEN** the personal tree SHALL remain untouched
- **AND** this host’s install SHALL be skipped
- **AND** the installer run SHALL complete without a non-zero exit solely due to the skip

#### Scenario: Non-TTY auto-relocates OMP personal skill

- **WHEN** a personal OMP skill is detected
- **AND** `process.stdin.isTTY` is falsy
- **THEN** the personal install is moved to a unique backup under `<home>/.omp/agent`
- **AND** the installer proceeds with the managed install
- **AND** the warning SHALL name the backup path
