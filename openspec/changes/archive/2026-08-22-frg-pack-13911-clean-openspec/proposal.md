## Why

Factory Reliability Gate (FRG) pack `pack-13911-tugboat-ship-1.39.11` needs one
clean OpenSpec-bearing item for release `1.39.11`. Issue #1217 is that synthetic
item. It must land a run-scoped fixture, one requirement, and one unit test,
with no production behavior change.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`.
  The fixture SHALL set `release_version` to `1.39.11`.
- Add one OpenSpec requirement that the fixture names release `1.39.11`.
- Add one unit test that reads only that run-scoped path and asserts
  `release_version` is `1.39.11`.
- Do **not** change production scripts, CLI, stages, prompts, labels, or
  merge behavior.

This is not **BREAKING**. Production runtime stays unchanged.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`
      exists and its `release_version` field is exactly `1.39.11`.
- [ ] A unit test reads only that run-scoped path and fails if
      `release_version` is missing or not `1.39.11`.
- [ ] The only active OpenSpec change for this issue is
      `frg-pack-13911-clean-openspec`.
- [ ] No production script, CLI, stage, prompt, or merge path changes.
- [ ] Pre-merge archives this change and leaves no foreign active change.
- [ ] `npm run ci` is green after implementation.

## Capabilities

### New Capabilities

- `frg-pack-13911-clean-openspec`: Run-scoped FRG clean-OpenSpec fixture for
  pack `pack-13911-tugboat-ship-1.39.11` must name release `1.39.11`, and a
  unit test must verify that value.

### Modified Capabilities

<!-- None. This is a synthetic pack instance. It does not change FRG driver,
     archive, or pipeline runtime requirements. -->

## Impact

- **Tests / fixtures only:**
  `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json`
  and a co-located unit test under `core/test/`.
- **OpenSpec:** one new capability, archived at pre-merge on this branch.
- **Does not:** edit `core/scripts/`, `plugin/`, merge paths, or FRG driver
  behavior. FRG still closes the PR and issue without merge after it records
  the run.
