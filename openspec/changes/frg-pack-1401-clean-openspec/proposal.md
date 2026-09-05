## Why

Issue #1457 is the factory-gate-v1 `clean-openspec` item for pack run
`pack-1401-pipeline-ship-1.40.1`. The pack needs one clean Pipeline path
that authors an OpenSpec change, lands a run-scoped fixture that names
release `1.40.1`, verifies that value, and archives without a foreign
active change.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- Add one OpenSpec requirement: that fixture MUST name release `1.40.1`.
- Add a unit test that reads only that run-scoped path and fails when the
  named release is not `1.40.1`.
- Do not change production behavior. No CLI, stage, config, host, or FRG
  driver edits.

**BREAKING:** none.

This is a synthetic FRG pack item, not a ship-path recover. The class is
the existing `clean-openspec` template. The site is this pack run. Shared
classifier, recipe, gate, and controller law stay unchanged. The next
identical pack item is rendered from
`core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md`.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-openspec`: the run-scoped clean-openspec fixture for
  pack `pack-1401-pipeline-ship-1.40.1` names release `1.40.1`, and a unit
  test proves that value. Production pipeline behavior does not change.

### Modified Capabilities

- (none)

## Impact

- New files only: the run-scoped JSON fixture, one unit test under
  `core/test/`, and this OpenSpec change (pre-merge archives it into
  `openspec/specs/frg-pack-1401-clean-openspec/`).
- Tests reuse `node:test` plus stdlib `node:fs` / `JSON.parse` (first
  holding rung: `core/test/frg-pack-13916-clean-openspec.test.ts` at
  `3ae9ac45`). No fixture loader, helper module, or registry.
- No production modules, npm dependencies, or SKILL overlay behavior
  change. A `core/test/`-only change does not require
  `node scripts/build.mjs`. Do not recreate `plugin/`.

## Acceptance criteria

- [ ] File
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
      exists and parses as JSON.
- [ ] That fixture names release `1.40.1` in field `release_version`
      (exact string).
- [ ] A unit test reads only that run-scoped path and fails if
      `release_version` is missing or is not `1.40.1`.
- [ ] The fixture and test use only that run-scoped path (no other
      `core/test/fixtures/frg/` pack-run directory).
- [ ] No production module under `core/scripts/` or `hosts/` changes
      behavior. `plugin/` is not recreated.
- [ ] This change (`frg-pack-1401-clean-openspec`) is the only active
      OpenSpec change for issue #1457. No foreign active change is
      introduced.
- [ ] The unit test performs no real network, git, or subprocess calls.
- [ ] Pre-merge archives this change and leaves no foreign active change.
- [ ] `npm run ci` is green.
- [ ] Advance and loop still stop at `pipeline:ready-to-deploy` and do
      not merge.
