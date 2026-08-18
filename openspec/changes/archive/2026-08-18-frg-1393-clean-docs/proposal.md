## Why

Issue #1121 is the Factory Reliability Gate (FRG) `clean-docs` item for
pack `pack-1393-goal-ship-1.39.3` (release `1.39.3`). The pack needs one
clean Pipeline path that adds a run-scoped documentation fixture and a
unit test, with no production behavior change.

This is a synthetic pack instance, not an engine defect. Class vs site:
the site is this run-scoped fixture. The class stays in
`frg-packs/factory-gate-v1` (`clean-docs` template). This change does
not alter classifier, recipe, gate, or controller law. The next pack
run uses the same template with a new `pack_run_id`.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json`.
- Add a unit test that reads that fixture from that path only and
  asserts `release_version` is `1.39.3`.
- Leave production code, FRG scoring, merge, and archive behavior
  unchanged.

This is not **BREAKING**.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.3`.
- [ ] A unit test under `core/test/` reads only that run-scoped path (no other pack-run fixture path).
- [ ] The unit test fails if `release_version` is missing or is not `1.39.3`.
- [ ] Production pipeline, FRG driver, and merge surfaces have no behavior change.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-1393-clean-docs`: Run-scoped clean-docs fixture and unit test for
  pack `pack-1393-goal-ship-1.39.3`. The fixture names release `1.39.3`.
  The test binds to that path and that version. Production behavior is
  unchanged.

### Modified Capabilities

- None. `factory-reliability-gate` already defines the `clean-docs`
  pack template. This instance does not change that capability.

## Impact

- **New test fixture:**
  `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json`
- **New or extended unit test** under `core/test/` that reads that file
- **Mirror:** regenerate `plugin/` only if a `core/` file other than
  tests requires it; test-only files still follow the repo gate
- **Does not:** change production scripts, FRG scoring, labels, merge,
  or living `factory-reliability-gate` requirements
