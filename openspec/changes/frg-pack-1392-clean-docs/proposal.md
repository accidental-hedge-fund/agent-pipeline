## Why

Factory Reliability Gate (FRG) pack `pack-1392-tugboat-ship-1.39.2` needs one
clean Pipeline item. That item is a run-scoped documentation fixture and a
unit test that binds `release_version` to `1.39.2`. The item must not change
production behavior.

## What Changes

- Add JSON fixture
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`.
- Add a unit test that reads only that run-scoped path.
- The test asserts `release_version` is exactly `1.39.2`.
- The test fails if that field is missing or has another value.
- No production script, stage, prompt, or CLI behavior changes.

This is not **BREAKING**.

## Acceptance Criteria

- [x] File `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`
      exists and is valid JSON.
- [x] That fixture sets `release_version` to the string `1.39.2`.
- [x] A unit test reads only that run-scoped path (no other pack-run
      fixture path).
- [x] The unit test fails when `release_version` is missing or is not
      `1.39.2`.
- [x] The change does not alter production pipeline behavior (no edits
      under `core/scripts/` that change runtime logic).
- [x] After any `core/` edit, `plugin/` is regenerated in the same change.
- [x] `npm run ci` is green.
- [ ] The issue can reach `pipeline:ready-to-deploy`. FRG close-without-merge
      stays an FRG driver duty, not this change.

## Capabilities

### New Capabilities

- `frg-pack-clean-docs-fixture`: Run-scoped clean-docs fixture for
  `pack-1392-tugboat-ship-1.39.2`. The fixture lives only at
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`.
  A unit test binds `release_version` to `1.39.2` and fails if that value
  changes. Production behavior stays unchanged.

### Modified Capabilities

- None. This pack item does not change Factory Reliability Gate scoring,
  pack close-without-merge, or any production stage.

## Impact

- **Tests / fixtures:** `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/`
  and a co-located `core/test/*.test.ts` that reads the fixture.
- **Production:** none. No stage, CLI, config, or prompt change.
- **Mirror / gate:** regenerate `plugin/` only if a `core/` file is added
  that the mirror copies. `npm run ci` must pass.
- **FRG:** this issue is the `clean-docs` item for
  `pack-1392-tugboat-ship-1.39.2`. Close-without-merge after score remains
  the existing FRG driver path (#1112 acceptance).
- **Does not:** change release/promote gates, skip-FRG config, merge
  authority, or any other pack template.
