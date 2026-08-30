## Why

Issue #1335 is the factory-gate-v1 `clean-openspec` template for pack run
`pack-13916-pipeline-ship-1.39.16`. The pack needs one clean Pipeline path that
authors an OpenSpec change, lands a run-scoped fixture, verifies the fixture
names release `1.39.16`, and archives without a foreign active change.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`.
- Add one OpenSpec requirement: that fixture MUST name release `1.39.16`.
- Add a unit test that reads only that run-scoped path and asserts the release
  value.
- Do not change production behavior. No CLI, stage, config, or FRG driver edits.

This is a synthetic FRG pack item, not a ship-path recover. The class is the
existing `clean-openspec` template. The site is this pack run. Shared
classifier, recipe, gate, and controller law stay unchanged.

## Capabilities

### New Capabilities

- `pack-13916-clean-openspec`: the run-scoped clean-openspec fixture for pack
  `pack-13916-pipeline-ship-1.39.16` names release `1.39.16`, and a unit test
  proves that value.

### Modified Capabilities

- (none)

## Impact

- New files only: the run-scoped JSON fixture, one unit test at
  `core/test/frg-pack-13916-clean-openspec.test.ts`, and this OpenSpec change
  (pre-merge archives it into `openspec/specs/pack-13916-clean-openspec/`).
- Tests reuse `node:test` plus `node:fs` `readFileSync` and `JSON.parse` (same
  pattern as `core/test/stage-output-contract.test.ts`). No fixture loader, helper
  module, or registry.
- No production modules, npm dependencies, or SKILL overlay behavior change.
  If a later `core/` edit happens, `node scripts/build.mjs` still runs; this
  change does not require that edit.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
      exists and parses as JSON.
- [ ] That fixture names release `1.39.16` (exact string).
- [ ] A unit test at `core/test/frg-pack-13916-clean-openspec.test.ts` reads only
      that run-scoped path and fails if the named release is not `1.39.16`.
- [ ] No production module under `core/scripts/` changes behavior.
- [ ] This is the only active OpenSpec change for issue #1335.
- [ ] Pre-merge archives this change and leaves no foreign active change.
- [ ] `npm run ci` is green.
