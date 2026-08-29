## REMOVED Requirements

### Requirement: Doctrine presence and preamble injection SHALL be regression-tested with plugin mirror hygiene

**Reason:** Issue #1048 removes copies of `core/scripts/prompts` from `plugin/`; the old mirror-hygiene requirement would reintroduce the retired distribution path.

**Migration:** Keep prompt regression tests and run the SKILL/catalog freshness generator after core edits without generating a plugin prompt copy.

## ADDED Requirements

### Requirement: Doctrine presence and preamble injection SHALL be regression-tested with packaging freshness

The change SHALL include unit tests that prove listed prompt builders emit the autonomy marker and critical invariant content. After any `core/` edit for this capability, `node scripts/build.mjs` SHALL run and any changed SKILL/catalog outputs SHALL be committed so `build.mjs --check` and `npm run ci` pass. No `plugin/` copy of `core/scripts/prompts` SHALL be generated.

#### Scenario: CI-facing tests cover preamble injection

- **WHEN** the core unit test suite runs
- **THEN** at least one test SHALL fail if a listed builder omits the ship-path autonomy version marker

#### Scenario: Packaging freshness stays green after core prompt changes

- **WHEN** implementation edits files under `core/scripts/prompts/`
- **THEN** `node scripts/build.mjs` SHALL run without generating a `plugin/` prompt copy
- **AND** changed SKILL/catalog outputs, if any, SHALL be included in the same change
- **AND** `node scripts/build.mjs --check` SHALL pass
