## Why

Factory Reliability Gate (FRG) pack `pack-1392-tugboat-ship-1.39.2` must
exercise one clean Pipeline path that includes an OpenSpec change and
archive. The pack needs a run-scoped fixture that names release `1.39.2`
so the path is checkable without a production behavior change.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`.
- Add one OpenSpec requirement that the fixture names release `1.39.2`.
- Add one unit test that reads that path and checks `release_version`.
- Do not change production pipeline behavior.

This is not **BREAKING**.

## Acceptance Criteria

- [ ] `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
      exists and sets `release_version` to the string `1.39.2`.
- [ ] A unit test reads only that run-scoped path and fails when
      `release_version` is not `1.39.2`.
- [ ] The fixture and test do not change production pipeline code or
      runtime behavior.
- [ ] This change is the only active OpenSpec change for issue #1113.
- [ ] Pre-merge archives this change. The pull request then has archived
      spec files and no foreign active change path.
- [ ] The Pipeline reaches `pipeline:ready-to-deploy` for issue #1113.

## Capabilities

### New Capabilities

- `frg-clean-openspec-fixture`: The pack-run fixture at
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
  SHALL name release `1.39.2`. A unit test SHALL verify that value.

### Modified Capabilities

- (none)

## Impact

- **Tests / fixtures only:**
  `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
  and a co-located unit test under `core/test/`.
- **OpenSpec:** one new capability, archived at pre-merge.
- **Mirror / gate:** if any `core/` file is added, regenerate `plugin/`
  in the same change. `npm run ci` must pass.
- **Does not:** change stages, CLI, labels, merge policy, FRG scoring,
  or production runtime behavior.
