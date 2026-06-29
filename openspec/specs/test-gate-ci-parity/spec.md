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
This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm run ci"`, where the `ci` npm script covers all steps run by this repo's CI pipeline: unit tests, the `plugin/` mirror sync check (`node scripts/build.mjs --check`), and the install smoke test. Because configured commands are now run through `bash -c` with `set -o pipefail`, multi-step operators (including pipes, where an early-stage failure correctly fails the gate) are also valid alternatives — but using `npm run ci` (which wraps all steps in a single npm script) remains the canonical form for this repo.

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

### Requirement: Configured test_gate.command is executed through bash with pipefail
When `test_gate.command` is set in `.github/pipeline.yml`, the pipeline SHALL run that command via `bash -c` with `set -o pipefail` enabled, giving the operator access to standard shell operators (`&&`, `||`, `;`, `|`, redirects) while ensuring a failing earlier stage in a pipeline fails the gate. The pipeline SHALL NOT tokenize the configured string before spawning; the shell is responsible for parsing. (`pipefail` is a bash feature; plain POSIX `sh`/dash cannot enforce it, so configured commands require `bash`.)

#### Scenario: Chained command with && passes when all steps succeed
- **WHEN** `test_gate.command` is set to `"cmd-a && cmd-b"` (where both commands exit 0)
- **THEN** the test gate SHALL execute the string through `bash -c` with `set -o pipefail`
- **AND** the gate SHALL report pass

#### Scenario: Piped command fails when an early stage fails
- **WHEN** `test_gate.command` is set to `"false | true"` (the first pipeline stage exits non-zero, the last exits 0)
- **THEN** `set -o pipefail` SHALL make the combined exit code non-zero
- **AND** the gate SHALL report failure rather than masking the early-stage failure behind the last stage's success

#### Scenario: Chained command with && fails when first step fails
- **WHEN** `test_gate.command` is set to `"false && true"` (first command exits non-zero)
- **THEN** the shell short-circuits and the combined exit code is non-zero
- **AND** the gate SHALL report failure

#### Scenario: Single-program configured command is unaffected
- **WHEN** `test_gate.command` is set to `"npm run ci"` (no shell operators)
- **THEN** the gate SHALL execute it through `bash -c` with `set -o pipefail` and the behavior SHALL be identical to direct spawn for a single command with no special characters

### Requirement: Auto-detected commands continue to use direct spawn
When `test_gate.command` is NOT set in `.github/pipeline.yml` and the pipeline auto-detects a test command (e.g. `pnpm run test`, `go test ./...`), it SHALL spawn the detected binary and arguments directly — without wrapping in a shell. The shell-execution path applies only to operator-supplied configured commands.

#### Scenario: Auto-detected npm test command runs via direct spawn
- **WHEN** `test_gate.command` is absent from config
- **AND** the pipeline detects `pnpm run test` from `package.json`
- **THEN** the gate SHALL invoke `pnpm` directly with args `["run", "test"]`
- **AND** SHALL NOT wrap the invocation in a shell

### Requirement: This repo's GitHub Actions CI workflow runs the full CI surface

The `.github/workflows/ci.yml` for this repository SHALL invoke `npm run ci` as its test command, rather than manually listing individual sub-steps. The `ci` npm script is the single source of truth for what constitutes a passing gate; duplicating its steps in YAML creates silent drift when the script is updated. By invoking `npm run ci` directly, any future additions to the script (such as `ci:launcher-smoke`) are automatically covered without a parallel YAML change.

#### Scenario: GitHub Actions CI invokes npm run ci

- **WHEN** a push or pull-request event triggers the `ci.yml` workflow
- **THEN** the workflow SHALL invoke `npm run ci` (or an equivalent single entry-point that transitively runs `ci:core`, `build.mjs --check`, `ci:install-smoke`, and `ci:launcher-smoke`)
- **AND** SHALL NOT enumerate those sub-steps as separate workflow steps

#### Scenario: launcher smoke failure fails CI

- **WHEN** `scripts/launcher-smoke.mjs` exits non-zero (e.g., a regression in the launcher)
- **THEN** the GitHub Actions CI job SHALL exit non-zero and the PR SHALL be blocked by CI
- **AND** SHALL NOT pass CI as though the launcher smoke step were absent

#### Scenario: CI log includes launcher smoke output

- **WHEN** a CI run completes successfully
- **THEN** the job log SHALL contain output from the launcher smoke step (e.g., `launcher smoke: N passed, 0 failed`)
- **AND** SHALL NOT omit that output because the step was never invoked

### Requirement: The CI gate validates the OpenSpec workspace when present

The repo's full CI gate (`npm run ci`) SHALL run `openspec validate --all` whenever an
`openspec/` directory exists at the repository root, and SHALL exit non-zero if any living
spec under `openspec/specs/` or any active change under `openspec/changes/` is structurally
invalid. The OpenSpec validation SHALL be a step within the `ci` npm script (alongside
`ci:core`, the `plugin/` mirror check, the install smoke test, and the launcher smoke test),
so that `.github/workflows/ci.yml` invoking `npm run ci` runs it without a separate bespoke
workflow step.

#### Scenario: invalid active change fails CI

- **WHEN** an active change under `openspec/changes/` is structurally invalid (e.g., a
  requirement is missing a `#### Scenario:`)
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit non-zero
- **AND** `npm run ci` SHALL fail, blocking the PR in `.github/workflows/ci.yml`

#### Scenario: invalid living spec fails CI

- **WHEN** a living spec under `openspec/specs/` is structurally invalid
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit non-zero and `npm run ci` SHALL fail

#### Scenario: valid workspace passes the OpenSpec step

- **WHEN** the entire `openspec/` workspace is structurally valid
- **AND** `npm run ci` runs
- **THEN** the OpenSpec validation step SHALL exit zero and SHALL NOT block CI

#### Scenario: a test asserts the ci script wires the OpenSpec step

- **WHEN** the `ci` npm script in `package.json` is inspected by a test
- **THEN** the test SHALL assert the chain includes the OpenSpec validation step
- **AND** the test SHALL fail if the OpenSpec validation step is removed from the `ci` chain

### Requirement: OpenSpec CI validation is conditional on an `openspec/` workspace

The OpenSpec CI validation step SHALL exit zero without invoking validation when the
repository has no `openspec/` directory, so the CI gate does not force OpenSpec onto
repositories, contexts, or installs that do not use it (including the install smoke test).
The step SHALL resolve the `openspec` CLI such that the gate runs successfully on a fresh CI
runner that does not have the CLI preinstalled.

#### Scenario: no `openspec/` directory — step is a no-op

- **WHEN** the OpenSpec validation step runs in a directory that has no `openspec/`
  workspace
- **THEN** the step SHALL exit zero
- **AND** SHALL NOT invoke `openspec validate`
- **AND** the rest of `npm run ci` SHALL be unaffected

#### Scenario: a test asserts the no-op-without-workspace behavior

- **WHEN** the OpenSpec validation step is run against a directory with no `openspec/`
  workspace in a test
- **THEN** the test SHALL assert the step exits zero without invoking validation
- **AND** the test SHALL fail if the step instead errors or attempts validation

#### Scenario: fresh runner without a preinstalled CLI still validates

- **WHEN** `npm run ci` runs on a CI runner that has no `openspec` CLI on PATH
- **AND** an `openspec/` workspace exists
- **THEN** the step SHALL resolve the CLI (e.g., via a deterministic on-demand fallback) and
  run `openspec validate --all` rather than failing with a "command not found" error

### Requirement: Build and test documentation names the OpenSpec validation gate

The repository's build/test guidance — `README.md`, `CLAUDE.md`, and `AGENTS.md` — SHALL
state that `npm run ci` validates the OpenSpec workspace (`openspec validate --all`) when an
`openspec/` directory is present, so contributors know a structurally invalid `openspec/`
fails the CI gate.

#### Scenario: README documents the OpenSpec CI gate

- **WHEN** a contributor reads the README build/test (`npm run ci`) section
- **THEN** they SHALL find that `npm run ci` includes `openspec validate --all` over the
  `openspec/` workspace

#### Scenario: CLAUDE.md and AGENTS.md document the OpenSpec CI gate

- **WHEN** a contributor reads the `Build & test` guidance in `CLAUDE.md` or `AGENTS.md`
- **THEN** they SHALL find that `npm run ci` validates the OpenSpec workspace as part of the
  required gate

