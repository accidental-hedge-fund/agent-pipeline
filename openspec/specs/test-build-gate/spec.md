# test-build-gate Specification

## Purpose
The test/build gate runs the target repo's own test/build command in the worktree and self-heals failures through a bounded generate→test→fix loop before the item advances. It auto-detects the command, stays non-blocking when none is found, and treats a dirty tree as untrustworthy. (The full-CI-command surface for this repo is refined by `test-gate-ci-parity`; the trailer/commit-message invariants on fix-harness commits are refined by `harness-step-verification`.)
## Requirements
### Requirement: Disabled gate is skipped
When `cfg.test_gate.enabled` is `false`, the gate SHALL return a skipped result immediately without detecting or running any command.

#### Scenario: gate disabled
- **WHEN** `cfg.test_gate.enabled` is `false`
- **THEN** the gate SHALL skip and SHALL NOT invoke any test/build command or fix harness

### Requirement: Command resolution — explicit override, else auto-detection
The command SHALL be the explicit `cfg.test_gate.command` (run via `sh -c`; the shell parses the string and the pipeline SHALL NOT tokenize it before spawning) when set; otherwise it SHALL be auto-detected with a defined precedence: a real `package.json` `test` script (package manager chosen from the lockfile — `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm; a placeholder/echo-only `test` script falls back to a build/typecheck script), then `go.mod`→`go test ./...`, `Cargo.toml`→`cargo test`, a concrete pytest marker→`pytest`, a `Makefile` `test:` target→`make test`. Auto-detected commands SHALL be spawned directly without shell wrapping.

#### Scenario: explicit override bypasses detection
- **WHEN** `cfg.test_gate.command` is set
- **THEN** that command SHALL be executed via `sh -c` and auto-detection SHALL be skipped

#### Scenario: detect package.json test with pnpm lockfile
- **WHEN** the worktree has a `package.json` `test` script and a `pnpm-lock.yaml`
- **THEN** the detected command SHALL run the test script via pnpm

#### Scenario: placeholder test script falls back
- **WHEN** the `package.json` `test` script is an npm placeholder (`echo "Error: no test specified" && exit 1`)
- **THEN** detection SHALL skip it and fall back to a build/typecheck script if present

### Requirement: Non-blocking when no command is detected
When no command is configured or detected, the gate SHALL skip without blocking — the pipeline stays usable on repos with no test/build command.

#### Scenario: empty repo
- **WHEN** the worktree has no recognized test/build command and no explicit override
- **THEN** the gate SHALL return skipped and SHALL NOT block the item

### Requirement: Worktree must be clean around a trusted run
Before the first run the worktree SHALL be clean; a dirty tree SHALL block (attempts 0) because results would be untrustworthy. After a passing run the tree SHALL still be clean; if the run produced uncommitted artifacts the gate SHALL block (the committed state differs from the tested state).

#### Scenario: dirty before the first run
- **WHEN** the worktree has uncommitted changes before the gate runs
- **THEN** the gate SHALL block with attempts 0 and SHALL NOT invoke the fix harness

#### Scenario: passing run leaves artifacts
- **WHEN** the command exits 0 but leaves the tree dirty
- **THEN** the gate SHALL block rather than report success

### Requirement: Bounded generate→test→fix loop
On a failing command the gate SHALL enter a loop bounded by `cfg.test_gate.max_attempts`: each attempt invokes the fix harness then re-runs the command; on a pass it returns success; after the attempts are exhausted it SHALL block with the captured output.

#### Scenario: fail then fix then pass
- **WHEN** the command fails initially and the fix harness's change makes the re-run pass
- **THEN** the gate SHALL return passed with the attempt count used

#### Scenario: attempts exhausted
- **WHEN** the command fails on the initial run and after all `max_attempts` fix attempts
- **THEN** the gate SHALL perform exactly `max_attempts` fix-harness invocations and then block with the captured output

### Requirement: Per-run timeout budget
Each command run SHALL be bounded by `cfg.test_gate.timeout` seconds; a timeout SHALL be treated as a failure with a timeout marker appended to the captured output.

#### Scenario: run exceeds the timeout
- **WHEN** a command run exceeds `cfg.test_gate.timeout`
- **THEN** it SHALL be killed and treated as a failed attempt

### Requirement: Test gate assumes worktree is dependency-installed
The test/build gate SHALL assume that the worktree's dependency install step has already completed (as guaranteed by the `worktree-dependency-install` bootstrap). The gate SHALL NOT attempt to detect or run a package manager install itself; if binaries are absent, it SHALL report the failing command output and block — not silently retry with an install.

#### Scenario: binaries available after bootstrap
- **WHEN** the worktree-dependency-install step has run successfully before the test gate executes
- **THEN** the test gate SHALL be able to invoke auto-detected or configured binaries (e.g., `pnpm run test`, `vitest`) without a "command not found" error

#### Scenario: gate does not install dependencies itself
- **WHEN** the test gate detects and runs a command
- **THEN** it SHALL NOT run any package manager install step before invoking the command
- **AND** install responsibility SHALL remain entirely with the worktree bootstrap phase
