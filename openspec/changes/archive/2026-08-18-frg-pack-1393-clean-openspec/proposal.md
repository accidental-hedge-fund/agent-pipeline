## Why

Factory Reliability Gate (FRG) pack `pack-1393-goal-ship-1.39.3` needs one
clean OpenSpec path for release `1.39.3`. The pack must prove propose,
implement, archive, and ready-to-deploy without a production behavior change.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json`.
- Add one OpenSpec requirement that this fixture names release `1.39.3`.
- Add one unit test that reads that path and checks the release value.
- Do not change production engine, CLI, stage, or merge behavior.

This is not **BREAKING**.

## Acceptance Criteria

- [ ] The only active OpenSpec change for this issue is
      `frg-pack-1393-clean-openspec`.
- [ ] The fixture exists at
      `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json`
      and sets `release_version` to the string `1.39.3`.
- [ ] A unit test reads only that run-scoped path and fails when
      `release_version` is not `1.39.3`.
- [ ] No production pipeline module changes behavior.
- [ ] Pre-merge archives this change and leaves no foreign active change.
- [ ] The pipeline reaches `pipeline:ready-to-deploy` for issue #1122.

## Capabilities

### New Capabilities

- `frg-pack-1393-clean-openspec`: Run-scoped FRG fixture for pack
  `pack-1393-goal-ship-1.39.3` that names release `1.39.3` and is checked
  by a unit test. No production behavior.

### Modified Capabilities

- None. This synthetic pack item does not change Factory Reliability Gate
  law, classifiers, recipes, or controllers.

## Impact

- **Fixture:** `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json`.
- **Tests:** one new unit test under `core/test/` that reads only that path.
- **Specs:** new capability `frg-pack-1393-clean-openspec`. After archive it
  becomes a living spec for this pack run.
- **Does not:** change `core/scripts/` production modules; add merge
  authority; alter FRG scoring; invent a second recoverer; touch `plugin/`
  unless a later implement step edits `core/`.
