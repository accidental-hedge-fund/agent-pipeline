## MODIFIED Requirements

### Requirement: OMP host install SHALL materialize core, overlay, launcher, manifest, and managed marker

`install --host omp` (tree mode) SHALL stage the shared `core/` tree, the `hosts/omp` overlay without a SKILL.md, and the shared launcher shim into the OMP skill directory, SHALL keep `hosts/omp/outer-host.manifest.json` and `core/scripts/outer-hosts/builtins/omp.json` byte-identical with `install.overlayFiles: []`, and SHALL write the `.pipeline-installer-managed` sentinel in the installed tree. Forced `--host omp` SHALL create `<home>/.omp/agent` when that directory is missing. OMP/Tugboat SHALL NOT require a host SKILL.md overlay.

#### Scenario: Fresh OMP install produces a managed skill tree

- **WHEN** no skill exists at `<home>/.omp/agent/skills/pipeline`
- **AND** `install --host omp` completes successfully (not dry-run)
- **THEN** that path SHALL contain the shared core, a launcher entry, and `.pipeline-installer-managed`
- **AND** that path SHALL NOT require an OMP host SKILL.md

#### Scenario: Repository overlay includes the OMP outer-host manifest

- **WHEN** this change is implemented
- **THEN** `hosts/omp/outer-host.manifest.json` SHALL exist
- **AND** its `id` SHALL be `omp`
- **AND** `core/scripts/outer-hosts/builtins/omp.json` SHALL match it byte-for-byte
- **AND** both manifests SHALL declare `install.overlayFiles` as `[]`
- **AND** `hosts/omp/SKILL.md` SHALL be absent

#### Scenario: Forced omp install creates a missing agent root

- **WHEN** `<home>/.omp/agent` does not exist
- **AND** `install --host omp` runs (not dry-run)
- **THEN** the installer SHALL create that base as needed for the skill tree
- **AND** SHALL complete the OMP install

#### Scenario: OMP install does not modify other hosts

- **WHEN** `install --host omp` runs
- **THEN** the installer SHALL NOT create, update, or delete Claude, Codex, Grok, or OpenCode skill artifacts as part of that host selection

#### Scenario: OMP overlay parity is enforced

- **WHEN** install and outer-host lifecycle tests enumerate OMP overlay files
- **THEN** both mirrored manifests SHALL report no SKILL overlay files
- **AND** the installed OMP tree SHALL contain no generated `SKILL.md`
