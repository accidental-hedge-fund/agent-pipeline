## MODIFIED Requirements

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
