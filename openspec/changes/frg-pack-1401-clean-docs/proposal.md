## Why

Factory Reliability Gate pack `pack-1401-pipeline-ship-1.40.1` needs one clean Pipeline item that proves a documentation fixture and its test, without changing production behavior. Issue #1456 is that synthetic `clean-docs` instance for release `1.40.1`.

## What Changes

- Add a run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- Add a unit test that reads that fixture from the same run-scoped path and asserts `release_version` is `1.40.1`.
- Leave production pipeline, CLI, FRG driver, merge, and host-skill behavior unchanged.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.40.1`.
- [ ] A unit test under `core/test/` reads only that run-scoped path (`core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`) and asserts `release_version === "1.40.1"`.
- [ ] Changing the fixture `release_version` to any other value makes that unit test fail.
- [ ] The change does not modify production code under `core/scripts/`, host skills, or merge/release commands.
- [ ] `cd core && npm test` includes the new test and the focused assertion passes against the committed fixture.
- [ ] `openspec validate frg-pack-1401-clean-docs` and root `npm run ci` pass.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: run-scoped `clean-docs` fixture and version-pinning unit test for pack `pack-1401-pipeline-ship-1.40.1`.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** this is a pack-instance site (`template_id=clean-docs`, `pack_run_id=pack-1401-pipeline-ship-1.40.1`), not a class defect. No shared classifier, recipe, gate, or controller changes. The next identical pack item is rendered from `core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md`.
- **Reuse first:** use existing `core/test/` layout, `node:test`, `node:fs`, and `JSON.parse`. Do not add a fixture loader, helper module, production API, or dependency.
- **Affected files:** one JSON fixture under `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/` and one unit test under `core/test/`.
- **Out of scope:** production behavior, FRG driver scoring, merge/auto-merge, host SKILL regeneration beyond freshness if `core/` test files trigger it, and any fixture path other than the run-scoped pack path.
