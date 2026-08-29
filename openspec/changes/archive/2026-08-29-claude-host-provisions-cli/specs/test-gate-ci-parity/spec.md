## MODIFIED Requirements

### Requirement: This repo's pipeline config sets the full CI command

This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm run ci"`, where the `ci` npm script covers all steps run by this repo's CI pipeline: unit tests, the SKILL/catalog freshness check (`node scripts/build.mjs --check`), and the install smoke test. Because configured commands are now run through `bash -c` with `set -o pipefail`, multi-step operators (including pipes, where an early-stage failure correctly fails the gate) are also valid alternatives — but using `npm run ci` (which wraps all steps in a single npm script) remains the canonical form for this repo. `build.mjs --check` SHALL fail on a stale generated SKILL overlay or marketplace catalog. It SHALL NOT fail solely because `plugin/` has no byte-identical core tree.

#### Scenario: pipeline.yml for agent-pipeline specifies the full CI command

- **WHEN** the agent-pipeline repo's `.github/pipeline.yml` is read
- **THEN** `test_gate.command` SHALL equal `"npm run ci"`

#### Scenario: ci npm script covers generated-artifact staleness

- **WHEN** the `ci` npm script is inspected in `package.json`
- **THEN** it SHALL invoke `node scripts/build.mjs --check` (directly or transitively) so that a stale generated SKILL overlay or marketplace catalog causes the script to exit non-zero

#### Scenario: stale generated packaging artifact is caught at the test gate, not at CI

- **WHEN** a pipeline run leaves the generated SKILL overlay or marketplace catalog stale
- **AND** the test gate runs `npm run ci`
- **THEN** the `node scripts/build.mjs --check` step SHALL exit non-zero and the test gate SHALL report failure — blocking before a PR is opened
- **AND** the fix harness SHALL receive the build-check output and attempt to resolve the staleness within the bounded fix loop

#### Scenario: missing plugin core copy does not fail the check

- **WHEN** `plugin/` has no byte-identical `core/scripts` tree
- **AND** generated SKILL overlay and marketplace catalog match
- **AND** the test gate runs `npm run ci`
- **THEN** `node scripts/build.mjs --check` SHALL NOT fail solely because the core copy is absent

#### Scenario: ci npm script covers the install smoke test

- **WHEN** the `ci` npm script is inspected in `package.json`
- **THEN** it SHALL invoke the install smoke test (directly or via `npm run ci:install-smoke`) so that a broken installer is caught in-pipeline

### Requirement: Explicit CI command covers full CI surface
When `test_gate.command` is set in `.github/pipeline.yml`, the gate MUST execute that command verbatim and treat its exit code as the gate result. The configured command is the operator's declaration that this command is equivalent to the repo's CI — a gate pass implies a CI pass for the covered steps.

#### Scenario: Script command covering multiple CI steps blocks the gate when any step fails
- **WHEN** `test_gate.command` is set to an npm script that chains multiple steps (e.g., `npm run ci`)
- **AND** the underlying script runs `npm test` (exits 0) followed by `node scripts/build.mjs --check` (exits non-zero, e.g., due to a stale generated SKILL overlay)
- **THEN** the gate SHALL report failure and block before opening a PR

#### Scenario: Script command where all steps pass allows the pipeline to proceed
- **WHEN** `test_gate.command` is set to an npm script that chains multiple steps
- **AND** all chained commands in that script exit 0
- **THEN** the gate SHALL report success and allow the pipeline to continue

### Requirement: The CI gate validates the OpenSpec workspace when present

The repo's full CI gate (`npm run ci`) SHALL run `openspec validate --all` whenever an
`openspec/` directory exists at the repository root, and SHALL exit non-zero if any living
spec under `openspec/specs/` or any active change under `openspec/changes/` is structurally
invalid. The OpenSpec validation SHALL be a step within the `ci` npm script (alongside
`ci:core`, the SKILL/catalog freshness check, the install smoke test, and the launcher smoke test),
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

### Requirement: Full CI surface includes docs freshness when the docs generator is present

When this repository includes the docs generator entry point (`scripts/generate-docs.mjs`) and/or a `docs:check` npm script that invokes it, the root `package.json` `ci` script SHALL invoke the docs freshness check (directly via `npm run docs:check` or `node scripts/generate-docs.mjs --check`, or transitively through an equivalent step) so that a stale generated docs artifact fails `npm run ci` the same way a stale SKILL overlay fails `node scripts/build.mjs --check`. Because this repo's `test_gate.command` is `"npm run ci"`, a green local test-gate SHALL imply a green docs freshness check for the committed tree whenever the generator is present.

#### Scenario: ci script wires docs:check when the generator exists

- **WHEN** `scripts/generate-docs.mjs` is present in the repository (or `package.json` defines `docs:check` for that generator)
- **AND** the `ci` npm script in root `package.json` is inspected via structural parse (JSON `scripts` map / transitive script targets, not solely a whole-file substring)
- **THEN** the `ci` script SHALL reach a **check-mode** docs freshness step (`docs:check` whose body invokes the generator with `--check`, or a direct `generate-docs.mjs --check` invocation)
- **AND** a drift-guard test SHALL fail if that step is removed while the generator remains

#### Scenario: write-mode docs:check does not satisfy CI freshness wiring

- **WHEN** `package.json` defines `docs:check` as a generator write-mode invocation without `--check` as an argument of the generator invocation itself (e.g. `node scripts/generate-docs.mjs`, or a compound script such as `node scripts/generate-docs.mjs && echo --check` where `--check` is not on the generator segment)
- **AND** the `ci` graph only reaches that write-mode script (no separate real check-mode edge)
- **THEN** structural inspection SHALL NOT report that `ci` reaches docs freshness

#### Scenario: stale generated docs fail the local test gate via npm run ci

- **WHEN** the worktree is docs-generator-present and a committed generated artifact is stale relative to a fresh generation
- **AND** the test gate runs `npm run ci` (this repo's configured command)
- **THEN** the docs freshness step SHALL exit non-zero
- **AND** the test gate SHALL report failure and block before the pipeline treats implement as successful for PR open
- **AND** unit tests alone passing SHALL NOT mask the docs-check failure

#### Scenario: generator absent does not require a docs:check step

- **WHEN** the repository has no docs generator entry point and no `docs:check` script
- **THEN** the `ci` script SHALL NOT be required to invoke a non-existent docs freshness command
- **AND** the drift-guard for docs wiring SHALL be inert or conditional on generator presence
