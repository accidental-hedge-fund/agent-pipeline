## MODIFIED Requirements

### Requirement: This repo's pipeline config sets the full CI command

This repo's `.github/pipeline.yml` SHALL set `test_gate.command` to `"npm run ci"`, where the `ci` npm script covers all steps run by this repo's CI pipeline: unit tests, the SKILL/catalog freshness check (`node scripts/build.mjs --check`), and the install smoke test. Because configured commands are now run through `bash -c` with `set -o pipefail`, multi-step operators (including pipes, where an early-stage failure correctly fails the gate) are also valid alternatives — but using `npm run ci` (which wraps all steps in a single npm script) remains the canonical form for this repo. `build.mjs --check` SHALL fail on a stale generated SKILL overlay or marketplace catalog. It SHALL NOT fail solely because `plugin/` has no byte-identical core tree.

#### Scenario: pipeline.yml for agent-pipeline specifies the full CI command

- **WHEN** the agent-pipeline repo's `.github/pipeline.yml` is read
- **THEN** `test_gate.command` SHALL equal `"npm run ci"`

#### Scenario: ci npm script covers the plugin-mirror staleness check

- **WHEN** the `ci` npm script is inspected in `package.json`
- **THEN** it SHALL invoke `node scripts/build.mjs --check` (directly or transitively) so that a stale generated SKILL overlay or marketplace catalog causes the script to exit non-zero

#### Scenario: stale plugin mirror is caught at the test gate, not at CI

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
