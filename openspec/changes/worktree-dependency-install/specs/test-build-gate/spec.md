## ADDED Requirements

### Requirement: Test gate assumes worktree is dependency-installed
The test/build gate SHALL assume that the worktree's dependency install step has already completed (as guaranteed by the `worktree-dependency-install` bootstrap). The gate SHALL NOT attempt to detect or run a package manager install itself; if binaries are absent, it SHALL report the failing command output and block — not silently retry with an install.

#### Scenario: binaries available after bootstrap
- **WHEN** the worktree-dependency-install step has run successfully before the test gate executes
- **THEN** the test gate SHALL be able to invoke auto-detected or configured binaries (e.g., `pnpm run test`, `vitest`) without a "command not found" error

#### Scenario: gate does not install dependencies itself
- **WHEN** the test gate detects and runs a command
- **THEN** it SHALL NOT run any package manager install step before invoking the command
- **AND** install responsibility SHALL remain entirely with the worktree bootstrap phase
