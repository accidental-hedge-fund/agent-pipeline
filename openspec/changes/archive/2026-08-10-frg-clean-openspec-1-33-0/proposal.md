## Why

Factory Reliability Gate (FRG) pack `factory-gate-v1` for release **1.33.0** needs one
synthetic issue that walks a clean Pipeline path with a real OpenSpec change and archive.
This change is that synthetic work item for pack run
`frg-1-33-0-f66627485c58a658c444ae3b`: it proves the OpenSpec plan → implement → archive
loop without changing production pipeline behavior.

## What Changes

- Add a **run-scoped** JSON fixture at
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json`
  that names release `1.33.0`.
- Add one OpenSpec requirement that the fixture's release field MUST be exactly `1.33.0`.
- Add a unit test that loads only that run-scoped path and asserts the release value.
- Do **not** change production stage logic, config, CLI, or other runtime behavior.
- Keep the active OpenSpec change scoped solely to this synthetic issue (#939); pre-merge
  archives it so no foreign active change remains.

## Capabilities

### New Capabilities

- `frg-clean-openspec-fixture`: the contract for the run-scoped FRG clean-OpenSpec JSON
  fixture for pack run `frg-1-33-0-f66627485c58a658c444ae3b` — path isolation, release
  identity `1.33.0`, and the unit-test guard that pins that value.

### Modified Capabilities

None. No production pipeline requirement changes.

## Impact

- **Test-only tree**: new directory
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/` and one co-located or
  nearby `core/test/*.test.ts` case.
- **No production code**: no edits under `core/scripts/`, `hosts/`, or runtime config.
- **Plugin mirror**: no `core/` production source change, so `node scripts/build.mjs`
  regeneration is not required for this fixture/test-only delta (confirm if any
  `core/` file that the mirror tracks is touched; fixture/test paths under `core/test/`
  are not mirrored as production behavior).
- **CI**: `cd core && npm test` and full `npm run ci` must stay green; `openspec validate
  --all` must accept this change and later its archive.
- **FRG lifecycle**: after the Pipeline reaches `pipeline:ready-to-deploy`, the FRG
  records the run and closes the PR and issue **without merge**.

## Acceptance Criteria

- [ ] File
      `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json`
      exists and is valid JSON.
- [ ] That fixture declares release identity exactly `1.33.0` (field name as specified in
      the design/spec, e.g. `release` or `release_version`).
- [ ] No other FRG pack-run fixture path is created or modified by this change.
- [ ] A unit test loads **only** that run-scoped fixture path and fails if the release
      value is not `1.33.0` (proven by temporary mutation).
- [ ] The unit test does not call real network, git, or subprocess APIs.
- [ ] No production behavior under `core/scripts/` changes (diff is fixture + test +
      OpenSpec artifacts only, until pre-merge archives the change).
- [ ] While the change is active, it is the only active OpenSpec change belonging to
      issue #939 / this synthetic pack item.
- [ ] Pre-merge archives `frg-clean-openspec-1-33-0` and leaves no foreign active OpenSpec
      change from this work.
- [ ] The Pipeline reaches `pipeline:ready-to-deploy` for issue #939.
- [ ] `cd core && npm test` and `npm run ci` are green after implementation.
