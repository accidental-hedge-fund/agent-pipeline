## Why

Issue #1177 is the Factory Reliability Gate (FRG) `clean-openspec` pack item
for `pack-1397-tugboat-ship-1.39.7`. The pack must exercise one clean
Pipeline path that authors, implements, and archives an OpenSpec change.
No production behavior is in scope.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json`.
- The fixture SHALL name release `1.39.7`.
- Add one unit test that reads only that path and verifies the release
  value.
- Author this OpenSpec change for issue #1177 only. Pre-merge archives it.
- Do not change production pipeline, Factory Reliability Gate (FRG) driver,
  or pack-scoring behavior.

This is not **BREAKING**.

## Acceptance criteria

- [ ] The file `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json` exists and is valid JSON.
- [ ] That fixture sets `release_version` to `1.39.7`.
- [ ] A co-located unit test under `core/test/` reads only that run-scoped path and fails if the named release is not `1.39.7`.
- [ ] The test uses no other pack-run fixture path and makes no real network, git, or subprocess calls.
- [ ] Production pipeline code, Factory Reliability Gate (FRG) driver code, and pack scoring are unchanged.
- [ ] The only active OpenSpec change for this work is `frg-pack-1397-clean-openspec`.
- [ ] Pre-merge archives that change. No foreign active change remains.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-pack-1397-clean-openspec`: Run-scoped FRG `clean-openspec` fixture
  for `pack-1397-tugboat-ship-1.39.7` must name release `1.39.7`. A unit
  test verifies that value. Production behavior does not change.

### Modified Capabilities

<!-- None. This is a synthetic pack item. It does not change Factory
     Reliability Gate (FRG) driver or pipeline stage requirements. -->

## Impact

- **Tests:** new JSON fixture under
  `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/` and one
  co-located unit test.
- **OpenSpec:** one new living spec after archive
  (`openspec/specs/frg-pack-1397-clean-openspec/spec.md`).
- **Production:** none. No CLI, stage, label, merge, or Factory Reliability
  Gate (FRG) scoring change.
- **Mirror:** if the test lives under `core/`, regenerate `plugin/` in the
  same change.
