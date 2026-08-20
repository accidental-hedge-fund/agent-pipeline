## Why

Factory Reliability Gate (FRG) pack `pack-1395-tugboat-ship-1.39.5` must exercise one clean Pipeline path that includes an OpenSpec change and archive. This synthetic issue exists so that path can run to `pipeline:ready-to-deploy` without changing production engine behavior.

## What Changes

- Add one run-scoped JSON fixture at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json`.
- Record one OpenSpec requirement that the fixture names release `1.39.5`.
- Add one unit test that reads that fixture and checks the release value.
- Leave production runtime code unchanged (`core/scripts/`, hosts, CLI, plugin mirror).

## Acceptance criteria

- [ ] The file `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` exists and is valid JSON.
- [ ] That fixture names release `1.39.5` in a field whose value is exactly the string `1.39.5`.
- [ ] A unit test fails if the fixture is missing, is not JSON, or names a different release.
- [ ] The fixture path and the test path use only the run-scoped directory `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/`.
- [ ] No production runtime file under `core/scripts/`, `hosts/`, or `plugin/` changes.
- [ ] The only active OpenSpec change for this issue is `frg-pack-1395-clean-openspec`.
- [ ] Pre-merge archives that change into living specs and leaves no foreign active change under `openspec/changes/` (archive only).
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-pack-1395-clean-openspec`: run-scoped FRG clean-openspec fixture for pack `pack-1395-tugboat-ship-1.39.5`. The fixture SHALL name release `1.39.5`. A unit test SHALL verify that value. Production engine behavior SHALL NOT change.

### Modified Capabilities

- (none)

## Impact

- **Tests only:** one JSON fixture under `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/` and one co-located unit test under `core/test/`.
- **OpenSpec:** one new capability that pre-merge archives into `openspec/specs/frg-pack-1395-clean-openspec/`.
- **Does not:** change FRG scoring, pack templates, advance, loop, merge, release, or Tugboat. Does not regenerate `plugin/` unless a later `core/scripts/` edit happens (this change has none).
- **Class vs site:** this is a synthetic FRG path exercise, not an engine-recovery mole. No classifier, recipe, gate, or controller change is in scope.
