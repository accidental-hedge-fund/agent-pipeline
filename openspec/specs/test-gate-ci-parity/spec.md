# test-gate-ci-parity Specification

## Purpose
TBD - created by archiving change test-gate-full-ci-command. Update Purpose after archive.
## Requirements
### Requirement: Explicit CI command covers full CI surface
When `test_gate.command` is set in `.github/pipeline.yml`, the gate MUST execute that command verbatim and treat its exit code as the gate result. The configured command is the operator's declaration that this command is equivalent to the repo's CI — a gate pass implies a CI pass for the covered steps.

#### Scenario: Script command covering multiple CI steps blocks the gate when any step fails
- **WHEN** `test_gate.command` is set to an npm script that chains multiple steps (e.g., `npm run ci`)
- **AND** the underlying script runs `npm test` (exits 0) followed by `node scripts/build.mjs --check` (exits non-zero, e.g., due to a stale generated mirror)
- **THEN** the gate SHALL report failure and block before opening a PR

#### Scenario: Script command where all steps pass allows the pipeline to proceed
- **WHEN** `test_gate.command` is set to an npm script that chains multiple steps
- **AND** all chained commands in that script exit 0
- **THEN** the gate SHALL report success and allow the pipeline to continue

### Requirement: Operator documentation for CI parity
The pipeline documentation (README) SHALL include a section explaining that if a repo's CI runs additional steps beyond the auto-detected `test` script (e.g., artifact sync checks, type checks, lint), the operator MUST set `test_gate.command` to a command that covers those additional steps.

#### Scenario: README documents when to set test_gate.command
- **WHEN** a developer reads the test/build gate section of the README
- **THEN** they SHALL find guidance stating that `test_gate.command` must match the repo's full CI command when CI includes steps beyond the default `test` script

#### Scenario: pipeline.yml includes inline comment for CI parity
- **WHEN** a developer looks at `.github/pipeline.yml` for this repo
- **THEN** they SHALL see a comment on or near `test_gate.command` explaining that the value matches the repo's full CI command

### Requirement: This repo's pipeline config sets the full CI command
This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm run ci"`, where the `ci` npm script covers all steps run by this repo's CI pipeline: unit tests, the `plugin/` mirror sync check (`node scripts/build.mjs --check`), and the install smoke test. A single-token command is required because `test_gate.command` is whitespace-tokenized and spawned without shell semantics — compound operators like `&&` must live inside the npm script, not in the config value.

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

