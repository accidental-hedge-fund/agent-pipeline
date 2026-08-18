## Why

Issue #1137 is the Factory Reliability Gate (FRG) `clean-openspec` item for
pack `pack-1394-tugboat-ship-1.39.4` (release `1.39.4`). The pack needs one
clean Pipeline path that carries an OpenSpec change through archive, adds a
run-scoped fixture and unit test, and does not change production behavior.

This is a synthetic pack instance, not an engine defect. Class vs site:
the site is this run-scoped fixture and its OpenSpec change. The class stays
in `frg-packs/factory-gate-v1` (`clean-openspec` template). This change does
not alter classifier, recipe, gate, or controller law. The next pack run uses
the same template with a new `pack_run_id`.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json`.
- Add one OpenSpec requirement that the fixture must name release `1.39.4`.
- Add a unit test that reads that fixture from that path only and asserts
  `release_version` is `1.39.4`.
- Leave production code, FRG scoring, merge, and archive behavior unchanged.

This is not **BREAKING**.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.4`.
- [ ] A unit test under `core/test/` reads only that run-scoped path (no other pack-run fixture path).
- [ ] The unit test fails if `release_version` is missing or is not `1.39.4`.
- [ ] The active OpenSpec change for this work belongs only to issue #1137 (no foreign active change).
- [ ] Production pipeline, FRG driver, and merge surfaces have no behavior change.
- [ ] After any `core/` edit that requires a mirror update, `plugin/` is regenerated in the same change.
- [ ] `npm run ci` is green.
- [ ] Pre-merge archives this OpenSpec change and leaves no foreign active change from this issue.
- [ ] The full Pipeline reaches `pipeline:ready-to-deploy` for this issue.

## Capabilities

### New Capabilities

- `frg-1394-clean-openspec`: Run-scoped clean-openspec fixture and unit test for
  pack `pack-1394-tugboat-ship-1.39.4`. The fixture names release `1.39.4`.
  The test binds to that path and that version. Production behavior is
  unchanged.

### Modified Capabilities

- None. `factory-reliability-gate` already defines the `clean-openspec`
  pack template. This instance does not change that capability.

## Impact

- **New test fixture:**
  `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json`
- **New or extended unit test** under `core/test/` that reads that file
- **OpenSpec:** this change only; pre-merge archives it into living specs
- **Mirror:** regenerate `plugin/` only if a `core/` file other than
  tests requires it; test-only files still follow the repo gate
- **Does not:** change production scripts, FRG scoring, labels, merge,
  or living `factory-reliability-gate` requirements
