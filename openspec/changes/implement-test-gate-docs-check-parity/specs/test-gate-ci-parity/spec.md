## ADDED Requirements

### Requirement: Full CI surface includes docs freshness when the docs generator is present

When this repository includes the docs generator entry point (`scripts/generate-docs.mjs`) and/or a `docs:check` npm script that invokes it, the root `package.json` `ci` script SHALL invoke the docs freshness check (directly via `npm run docs:check` or `node scripts/generate-docs.mjs --check`, or transitively through an equivalent step) so that a stale generated docs artifact fails `npm run ci` the same way a stale `plugin/` mirror fails `node scripts/build.mjs --check`. Because this repo's `test_gate.command` is `"npm run ci"`, a green local test-gate SHALL imply a green docs freshness check for the committed tree whenever the generator is present.

#### Scenario: ci script wires docs:check when the generator exists

- **WHEN** `scripts/generate-docs.mjs` is present in the repository (or `package.json` defines `docs:check` for that generator)
- **AND** the `ci` npm script in root `package.json` is inspected
- **THEN** the `ci` script SHALL include the docs freshness step (`docs:check` or `generate-docs.mjs --check`)
- **AND** a drift-guard test SHALL fail if that step is removed while the generator remains

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

### Requirement: Operator and agent docs name docs:check as part of the full CI surface when present

When the docs generator is present, repository build/test guidance that documents `npm run ci` (README and/or CLAUDE.md / AGENTS.md as applicable) SHALL mention that the full CI gate includes docs freshness (`docs:check` / generate-docs `--check`) so contributors and implementers know stale generated docs fail the same local command the test-gate runs.

#### Scenario: Build guidance mentions docs freshness when generator is present

- **WHEN** the docs generator is present and a contributor reads the build/test (`npm run ci`) guidance
- **THEN** they SHALL find that `npm run ci` includes the docs freshness check
- **AND** SHALL NOT be led to believe that green unit tests alone equal full CI when generated docs are stale
