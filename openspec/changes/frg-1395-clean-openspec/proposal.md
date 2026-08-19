## Why

Factory Reliability Gate (FRG) pack `pack-1395-tugboat-ship-1.39.5` must exercise one clean Pipeline path that includes an OpenSpec change and later archive. The pack needs a run-scoped test fixture that names release `1.39.5` so the synthetic issue can complete without changing production behavior.

## What Changes

- Add one run-scoped JSON fixture at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json`.
- Add one OpenSpec requirement that the fixture names release `1.39.5`.
- Add one unit test that reads that fixture and checks the release value.
- Do not change production runtime, CLI, or stage behavior.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` exists.
- [ ] That fixture JSON names release `1.39.5`.
- [ ] A unit test reads only that run-scoped path and fails when the release is not `1.39.5`.
- [ ] No production script, stage, CLI, or config behavior changes.
- [ ] This change is the only active OpenSpec change for issue #1144.
- [ ] Pre-merge archives this change and leaves no foreign active change.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-1395-clean-openspec`: Run-scoped FRG pack fixture for `pack-1395-tugboat-ship-1.39.5` that must name release `1.39.5`.

### Modified Capabilities

<!-- None. This pack-run fixture is not living factory-reliability-gate law. -->

## Impact

- New files only under `core/test/` (fixture + unit test).
- New capability spec `openspec/specs/frg-1395-clean-openspec/` after archive.
- No production API, CLI, stage, or dependency change.
- If `core/` files change, `scripts/build.mjs` must refresh `plugin/` in the same change.
