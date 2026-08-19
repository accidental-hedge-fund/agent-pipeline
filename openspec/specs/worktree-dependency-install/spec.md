# worktree-dependency-install Specification

## Purpose
TBD - created by archiving change worktree-dependency-install. Update Purpose after archive.

## Requirements

### Requirement: Dependency install auto-detected from lockfile
After a worktree is created, the pipeline SHALL detect the package manager from the lockfile present in the worktree root and run the corresponding install command: `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`. When multiple lockfiles are present at the same package root, precedence is: pnpm > yarn > npm. When the worktree root contains no recognized lockfile and no `setup_command` is configured, the pipeline SHALL apply the first-level nested-lockfile fallback. The install step SHALL be skipped without error only when neither the worktree root nor exactly one first-level subdirectory contains a recognized lockfile.

#### Scenario: pnpm lockfile detected
- **WHEN** the worktree root contains `pnpm-lock.yaml`
- **THEN** the pipeline SHALL run `pnpm install` in the worktree before any stage executes

#### Scenario: yarn lockfile detected
- **WHEN** the worktree root contains `yarn.lock` and no `pnpm-lock.yaml`
- **THEN** the pipeline SHALL run `yarn install` in the worktree before any stage executes

#### Scenario: npm lockfile detected
- **WHEN** the worktree root contains `package-lock.json` and no `pnpm-lock.yaml` or `yarn.lock`
- **THEN** the pipeline SHALL run `npm ci` in the worktree before any stage executes

#### Scenario: no lockfile present
- **WHEN** the worktree root contains no recognized lockfile
- **AND** no first-level subdirectory contains a recognized lockfile
- **AND** no `setup_command` is configured
- **THEN** the install step SHALL be skipped without error and the pipeline SHALL continue normally

### Requirement: Idempotent — skip when node_modules already populated
When `node_modules` already exists at the detected package root and no explicit `setup_command` is configured, the install step SHALL be skipped without re-running the package manager. The detected package root is the worktree root when the lockfile is at the root. The detected package root is the first-level subdirectory when the lockfile is nested. A `node_modules` directory at the worktree root SHALL NOT skip install when the detected package root is a first-level subdirectory that has no `node_modules`.

#### Scenario: node_modules present, no setup_command
- **WHEN** `<worktree>/node_modules` exists
- **AND** the worktree root contains a recognized lockfile
- **AND** `setup_command` is not set in config
- **THEN** the install step SHALL be skipped and the pipeline SHALL proceed without running any install command

#### Scenario: node_modules present but setup_command explicitly set
- **WHEN** `<worktree>/node_modules` exists
- **AND** `setup_command` is set to a non-empty string in config
- **THEN** the configured `setup_command` SHALL still run (setup_command overrides the idempotency check)

#### Scenario: nested node_modules present skips nested install
- **WHEN** `<worktree>/core/package-lock.json` exists
- **AND** `<worktree>/core/node_modules` exists
- **AND** the worktree root contains no recognized lockfile
- **AND** `setup_command` is not set
- **THEN** the install step SHALL be skipped

#### Scenario: root node_modules does not skip nested install
- **WHEN** `<worktree>/node_modules` exists
- **AND** the worktree root contains no recognized lockfile
- **AND** `<worktree>/core/package-lock.json` exists
- **AND** `<worktree>/core/node_modules` does not exist
- **AND** `setup_command` is not set
- **THEN** the pipeline SHALL run `npm ci` with CWD `<worktree>/core`

### Requirement: setup_command config override
When `setup_command` is set in `.github/pipeline.yml`, the pipeline SHALL run that command (via shell) in place of auto-detection. When `setup_command` is set to an empty string, the install step SHALL be skipped entirely.

#### Scenario: custom setup_command runs instead of auto-detection
- **WHEN** `setup_command` is set to a non-empty string (e.g., `"pnpm install --frozen-lockfile && pnpm build"`)
- **THEN** the pipeline SHALL run that command via shell in the worktree
- **AND** SHALL NOT perform lockfile-based auto-detection

#### Scenario: empty setup_command opts out
- **WHEN** `setup_command` is set to `""`
- **THEN** the install step SHALL be skipped
- **AND** auto-detection SHALL NOT run even if a lockfile is present

#### Scenario: empty setup_command opts out of nested core/ install
- **WHEN** `setup_command` is set to `""`
- **AND** `<worktree>/core/package-lock.json` exists
- **AND** `<worktree>/core/node_modules` does not exist
- **THEN** the install step SHALL be skipped
- **AND** SHALL NOT run `npm ci` in `core/`

#### Scenario: non-empty setup_command ignores nested lockfile
- **WHEN** `setup_command` is set to a non-empty string
- **AND** the worktree root contains no recognized lockfile
- **AND** `<worktree>/core/package-lock.json` exists
- **THEN** the pipeline SHALL run the configured command via shell with CWD set to the worktree root
- **AND** SHALL NOT auto-detect or run `npm ci` in `core/`

### Requirement: Install failure blocks the pipeline with a clear error
When the install command (auto-detected or configured) exits non-zero, the pipeline SHALL stop immediately with an error that names the command that failed and its exit code. It SHALL NOT proceed to any subsequent stage.

#### Scenario: pnpm install exits non-zero
- **WHEN** the auto-detected `pnpm install` exits with a non-zero status
- **THEN** the pipeline SHALL block and report the failure, naming `pnpm install` as the failed command
- **AND** SHALL NOT execute any pipeline stage (planning, review, test gate, etc.)

#### Scenario: setup_command exits non-zero
- **WHEN** the configured `setup_command` exits with a non-zero status
- **THEN** the pipeline SHALL block and report the failure, including the exit code

### Requirement: Install step output is visible in pipeline logs
The stdout and stderr of the install command SHALL be captured and surfaced in the pipeline's log output so operators can diagnose slow or failing installs.

#### Scenario: install output shown in log
- **WHEN** the install command runs (auto-detected or configured)
- **THEN** its stdout and stderr SHALL appear in the pipeline's run output, attributed to the setup step

### Requirement: Nested first-level lockfile SHALL install in that directory
The pipeline SHALL run the matching package-manager install in a first-level subdirectory when `setup_command` is unset, the worktree root contains no recognized lockfile, and exactly one first-level subdirectory contains a recognized lockfile. A first-level subdirectory is an immediate child of the worktree root. The scan SHALL NOT recurse below that child. The scan SHALL ignore `.git`, `node_modules`, and names that start with `.`. When that single subdirectory is `core/` and it contains `package-lock.json` with no `pnpm-lock.yaml` or `yarn.lock`, the command SHALL be `npm ci` and the CWD SHALL be that `core/` directory. When more than one first-level subdirectory contains a recognized lockfile, the auto-detect step SHALL skip without error. A lockfile deeper than one directory (for example `plugin/pipeline/skills/pipeline/core/package-lock.json`) SHALL NOT be auto-detected.

#### Scenario: core/package-lock.json is the only first-level lockfile
- **WHEN** the worktree root contains no recognized lockfile
- **AND** `<worktree>/core/package-lock.json` exists
- **AND** no other first-level subdirectory contains a recognized lockfile
- **AND** `<worktree>/core/node_modules` does not exist
- **AND** `setup_command` is not set
- **THEN** the pipeline SHALL run `npm ci` with CWD `<worktree>/core` before planning or implementing starts
- **AND** the setup result SHALL not be skipped

#### Scenario: root lockfile wins over a nested lockfile
- **WHEN** the worktree root contains `package-lock.json`
- **AND** `<worktree>/core/package-lock.json` also exists
- **AND** `<worktree>/node_modules` does not exist
- **AND** `setup_command` is not set
- **THEN** the pipeline SHALL run `npm ci` with CWD set to the worktree root
- **AND** SHALL NOT run a second install in `core/`

#### Scenario: multiple first-level lockfile directories skip auto-detect
- **WHEN** the worktree root contains no recognized lockfile
- **AND** both `<worktree>/core/package-lock.json` and `<worktree>/app/package-lock.json` exist
- **AND** `setup_command` is not set
- **THEN** the install step SHALL be skipped without error

#### Scenario: lockfile deeper than one directory is not auto-detected
- **WHEN** the worktree root contains no recognized lockfile
- **AND** no first-level subdirectory contains a recognized lockfile
- **AND** a lockfile exists at a deeper path such as `plugin/pipeline/skills/pipeline/core/package-lock.json`
- **AND** `setup_command` is not set
- **THEN** the install step SHALL be skipped without error

#### Scenario: nested npm ci failure blocks setup
- **WHEN** the nested fallback selects `<worktree>/core/package-lock.json`
- **AND** `npm ci` in that directory exits with a non-zero status
- **THEN** the pipeline SHALL block with `worktree-setup-failed`
- **AND** the error SHALL name `npm ci` and the exit code
- **AND** SHALL NOT start planning or implementing

### Requirement: Nested-lockfile install SHALL have a biting unit test
The worktree dependency-install unit-test suite SHALL include a case whose fixture is only `core/package-lock.json`, with `core/node_modules` absent and `setup_command` unset. That case SHALL require the spawned command to be `npm ci` and the CWD to be the `core/` directory. Removing the nested-lockfile fallback SHALL make that test fail.

#### Scenario: unit test fails without the nested fallback
- **WHEN** the fixture presents only `<worktree>/core/package-lock.json` and no `<worktree>/core/node_modules`
- **AND** `setup_command` is unset
- **AND** the nested-lockfile fallback is absent (root-only detection as shipped by #174)
- **THEN** the unit test SHALL fail because the install is skipped or is not `npm ci` with CWD `core/`
