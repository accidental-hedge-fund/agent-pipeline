## Why

Factory Reliability Gate (FRG) pack `pack-1401-pipeline-ship-1.40.1` must exercise one clean Pipeline path. Issue #1442 is that pack's `clean-docs` instance. The pack needs a run-scoped documentation fixture and a unit test that pins `release_version` to `1.40.1`.

## What Changes

- Add JSON fixture `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` that names `release_version` `1.40.1`.
- Add one `node:test` unit test that reads only that run-scoped path and fails if `release_version` is not `1.40.1`.
- Do not change production CLI, stages, merge authority, or FRG engine behavior.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: run-scoped `clean-docs` fixture and unit test for pack `pack-1401-pipeline-ship-1.40.1` with `release_version` `1.40.1`.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** this issue is a factory-gate pack instance, not a recover or engine-class fault. The class is the versioned `clean-docs` template in `factory-gate-v1`. This change implements that instance for `pack-1401-pipeline-ship-1.40.1`. It does not add a new FRG template, classifier, recipe, gate, or controller. The next identical pack run uses the same template. It does not need a new mole issue.
- **Reuse first:** keep `core/test/` plus Node `node:test`, `node:fs` `readFileSync`, and `JSON.parse`. Do not add a fixture loader, helper module, CLI verb, production path, or new dependency.
- **CLI:** no new public verb. Advance and loop still do not merge.
- **Tests:** one hermetic unit test. No network, git, or subprocess.
- **Out of scope:** production behavior, FRG engine, merge, auto-close, and the sibling `clean-openspec` pack item.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field is the string `1.40.1`.
- [ ] A unit test under `core/test/` reads only that run-scoped path and asserts `release_version` equals `1.40.1`.
- [ ] The unit test fails when that fixture's `release_version` is any other value.
- [ ] Production CLI, stages, merge, and FRG engine code do not change.
- [ ] `cd core && npm test` includes the new test and the test passes against the committed fixture.
- [ ] `npm run ci` passes from the repo root.
