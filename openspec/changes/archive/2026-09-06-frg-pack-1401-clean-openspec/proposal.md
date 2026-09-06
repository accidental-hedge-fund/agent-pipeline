## Why

Issue #1487 is the synthetic Factory Reliability Gate `clean-openspec` item
for release `1.40.1`. The pack must exercise a clean Pipeline path containing
an OpenSpec change and archive, using only its run-scoped fixture.

## What Changes

- Add the run-scoped `clean-openspec.json` fixture for pack
  `pack-1401-pipeline-ship-1.40.1`.
- Require the fixture to name release `1.40.1`.
- Add a unit test that reads only that path and fails for another value.
- Do not change production behavior.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-openspec`: The pack-scoped fixture names release
  `1.40.1` at its run-scoped path and has a biting unit test.

### Modified Capabilities

<!-- None. This is a synthetic pack instance, not a change to FRG scoring law. -->

## Impact

- Adds one JSON fixture and one `node:test` file under `core/test/`.
- Adds only this issue's OpenSpec change; pre-merge archives it.
- Does not alter `core/scripts/`, hosts, configuration, or merge behavior.
