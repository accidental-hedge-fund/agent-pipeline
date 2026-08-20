## Why

Factory Reliability Gate (FRG) pack `pack-1396-tugboat-ship-1.39.6` must
exercise one clean Pipeline path that includes an OpenSpec change and
archive. Release `1.39.6` has no run-scoped OpenSpec fixture or test at
the pack path, so that path is unproven.

## What Changes

- Add one JSON fixture at
  `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`.
- Add one OpenSpec requirement that the fixture names release `1.39.6`.
- Add one unit test that reads that fixture and checks the release value.
- Do not change production runtime behavior.

This is not **BREAKING**.

## Acceptance Criteria

- [ ] The fixture file exists at
      `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`.
- [ ] The fixture names release `1.39.6` in field `release_version`.
- [ ] A unit test reads only that run-scoped path and fails when
      `release_version` is not `1.39.6`.
- [ ] No production module under `core/scripts/` changes behavior.
- [ ] This issue has exactly one active OpenSpec change
      (`frg-pack-1396-clean-openspec`). No foreign active change is
      introduced.
- [ ] Pre-merge archives this change. The PR then has archived change
      files and living spec files, and no active `openspec/changes/<id>/`
      path.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-pack-1396-clean-openspec`: Run-scoped FRG OpenSpec fixture for
  pack `pack-1396-tugboat-ship-1.39.6`. The fixture names release
  `1.39.6`. A unit test checks that value. Production behavior is
  unchanged.

### Modified Capabilities

_(none)_

## Impact

- **Fixture:** `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json`
- **Test:** a co-located unit test under `core/test/` that reads only
  that path
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Does not:** change FRG driver, advance, merge, ship, or any
  production stage. Does not add a second OpenSpec change. Does not
  write fixtures under a shared (non-run-scoped) path.
