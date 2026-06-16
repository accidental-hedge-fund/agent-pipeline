## ADDED Requirements

### Requirement: Dependency install auto-detected from lockfile
After a worktree is created, the pipeline SHALL detect the package manager from the lockfile present in the worktree root and run the corresponding install command: `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json` → `npm ci`. When multiple lockfiles are present, precedence is: pnpm > yarn > npm.

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
- **WHEN** the worktree root contains no recognized lockfile and no `setup_command` is configured
- **THEN** the install step SHALL be skipped without error and the pipeline SHALL continue normally

### Requirement: Idempotent — skip when node_modules already populated
When `node_modules` already exists in the worktree root and no explicit `setup_command` is configured, the install step SHALL be skipped without re-running the package manager.

#### Scenario: node_modules present, no setup_command
- **WHEN** `<worktree>/node_modules` exists
- **AND** `setup_command` is not set in config
- **THEN** the install step SHALL be skipped and the pipeline SHALL proceed without running any install command

#### Scenario: node_modules present but setup_command explicitly set
- **WHEN** `<worktree>/node_modules` exists
- **AND** `setup_command` is set to a non-empty string in config
- **THEN** the configured `setup_command` SHALL still run (setup_command overrides the idempotency check)

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
