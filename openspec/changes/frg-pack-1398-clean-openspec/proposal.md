## Why

Issue #1195 is the Factory Reliability Gate (FRG) `clean-openspec` item for
pack run `pack-1398-tugboat-ship-1.39.8`. The pipeline must prove one clean
OpenSpec path: propose a change, implement a run-scoped fixture and test,
then archive that change. Production engine behavior does not change.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json`.
  The fixture SHALL name release `1.39.8`.
- Add one OpenSpec requirement that states that fixture MUST name release
  `1.39.8`.
- Add one unit test that reads only that fixture path and verifies the
  release value is `1.39.8`.
- Do not change production scripts, CLI, stages, prompts, or config.
- Pre-merge archives this change. No foreign active OpenSpec change remains.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.8`.
- [ ] A unit test under `core/test/` reads only that run-scoped path and
      fails if `release_version` is missing or not `1.39.8`.
- [ ] The unit test does not read any other `core/test/fixtures/frg/` pack
      directory.
- [ ] The unit test does not import production modules under `core/scripts/`.
- [ ] No production module under `core/scripts/` changes behavior.
- [ ] The only active OpenSpec change for this issue is
      `frg-pack-1398-clean-openspec`.
- [ ] Pre-merge archives that change into `openspec/changes/archive/` and
      `openspec/specs/`. No path under `openspec/changes/` other than
      `archive/` remains for a foreign active change.
- [ ] `npm run ci` is green. After any `core/` edit, `plugin/` is
      regenerated in the same change.

## Capabilities

### New Capabilities

- `frg-pack-1398-clean-openspec`: Run-scoped FRG fixture for pack
  `pack-1398-tugboat-ship-1.39.8`. The fixture names release `1.39.8`. A
  unit test verifies that value. Production behavior is unchanged.

### Modified Capabilities

<!-- None. This synthetic pack item does not change living factory-gate
     or pipeline stage requirements. -->

## Impact

- **Tests / fixtures:** new JSON under
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/` and
  `core/test/frg-pack-1398-clean-openspec.test.ts`.
- **OpenSpec:** one new capability spec archived at pre-merge.
- **Plugin mirror:** regenerate `plugin/` if any `core/` file is added.
- **Does not:** change `core/scripts/` production behavior, merge, or
  alter other FRG pack templates.
