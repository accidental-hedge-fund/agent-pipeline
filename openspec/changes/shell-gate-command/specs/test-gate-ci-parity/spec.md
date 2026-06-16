## ADDED Requirements

### Requirement: Configured test_gate.command is executed through a POSIX shell
When `test_gate.command` is set in `.github/pipeline.yml`, the pipeline SHALL run that command via `sh -c "<command>"`, giving the operator access to standard POSIX shell operators (`&&`, `||`, `;`, `|`, redirects). The pipeline SHALL NOT tokenize the configured string before spawning; the shell is responsible for parsing.

#### Scenario: Chained command with && passes when all steps succeed
- **WHEN** `test_gate.command` is set to `"cmd-a && cmd-b"` (where both commands exit 0)
- **THEN** the test gate SHALL execute the string through `sh -c`
- **AND** the gate SHALL report pass

#### Scenario: Chained command with && fails when first step fails
- **WHEN** `test_gate.command` is set to `"false && true"` (first command exits non-zero)
- **THEN** the shell short-circuits and the combined exit code is non-zero
- **AND** the gate SHALL report failure

#### Scenario: Single-program configured command is unaffected
- **WHEN** `test_gate.command` is set to `"npm run ci"` (no shell operators)
- **THEN** the gate SHALL execute it through `sh -c` and the behavior SHALL be identical to direct spawn for a single command with no special characters

### Requirement: Auto-detected commands continue to use direct spawn
When `test_gate.command` is NOT set in `.github/pipeline.yml` and the pipeline auto-detects a test command (e.g. `pnpm run test`, `go test ./...`), it SHALL spawn the detected binary and arguments directly — without wrapping in `sh -c`. The shell-execution path applies only to operator-supplied configured commands.

#### Scenario: Auto-detected npm test command runs via direct spawn
- **WHEN** `test_gate.command` is absent from config
- **AND** the pipeline detects `pnpm run test` from `package.json`
- **THEN** the gate SHALL invoke `pnpm` directly with args `["run", "test"]`
- **AND** SHALL NOT wrap the invocation in `sh -c`

## MODIFIED Requirements

### Requirement: This repo's pipeline config sets the full CI command
This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm run ci"`, where the `ci` npm script covers all steps run by this repo's CI pipeline: unit tests, the `plugin/` mirror sync check (`node scripts/build.mjs --check`), and the install smoke test. Because configured commands are now run through a POSIX shell, multi-step operators are also valid alternatives — but using `npm run ci` (which wraps all steps in a single npm script) remains the canonical form for this repo.

#### Scenario: pipeline.yml for agent-pipeline specifies the full CI command
- **WHEN** the agent-pipeline repo's `.github/pipeline.yml` is read
- **THEN** `test_gate.command` SHALL equal `"npm run ci"`

#### Scenario: ci npm script covers the plugin-mirror staleness check
- **WHEN** the `ci` npm script is inspected in `package.json`
- **THEN** it SHALL invoke `node scripts/build.mjs --check` (directly or transitively) so that a stale `plugin/` mirror causes the script to exit non-zero

#### Scenario: stale plugin mirror is caught at the test gate, not at CI
- **WHEN** a pipeline run edits `core/` source without regenerating the `plugin/` mirror
- **AND** the test gate runs `npm run ci`
- **THEN** the `node scripts/build.mjs --check` step SHALL exit non-zero and the test gate SHALL report failure — blocking before a PR is opened
- **AND** the fix harness SHALL receive the build-check output and attempt to resolve the staleness within the bounded fix loop

#### Scenario: ci npm script covers the install smoke test
- **WHEN** the `ci` npm script is inspected in `package.json`
- **THEN** it SHALL invoke the install smoke test (directly or via `npm run ci:install-smoke`) so that a broken installer is caught in-pipeline
