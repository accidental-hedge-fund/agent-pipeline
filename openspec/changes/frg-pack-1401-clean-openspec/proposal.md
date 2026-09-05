## Why

Issue #1449 is a synthetic Factory Reliability Gate (FRG) pack item. It exercises one clean Pipeline path that includes an OpenSpec change and archive. The pack run needs a run-scoped fixture that names release `1.40.1`, one OpenSpec requirement for that value, and a unit test that checks it. Production pipeline behavior does not change.

## What Changes

- Add one JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- The fixture SHALL name release `1.40.1` in field `release_version`.
- Add one unit test under `core/test/` that reads only that run-scoped path and asserts `release_version` is `1.40.1`.
- Pre-merge archives this change into the living spec. No foreign active change remains.
- No production CLI, stage, merge, or FRG driver behavior changes.

## Capabilities

### New Capabilities

- `frg-pack-1401-pipeline-ship-clean-openspec`: the pack-1401-pipeline-ship-1.40.1 clean-openspec fixture SHALL name release `1.40.1`.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** this issue is a synthetic factory-gate pack item (`template_id=clean-openspec`). It is not engine recovery. No shared classifier, recipe, gate, or controller change is in scope.
- **Reuse first:** reuse `node:fs` `readFileSync` plus `JSON.parse` as in `core/test/declared-dependency-grammar.test.ts`. Do not add a fixture loader, helper module, config key, or production API.
- **Tests:** one hermetic unit test. No network, git, or subprocess.
- **CLI / merge:** no new verb. Advance and loop still stop at `pipeline:ready-to-deploy`. No merge-authority change.
- **Docs / hosts:** no production docs or host SKILL change unless a later `core/` edit requires `node scripts/build.mjs`.

## Acceptance Criteria

- [ ] The only active OpenSpec change is `frg-pack-1401-clean-openspec`.
- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` exists.
- [ ] That fixture JSON has `release_version` equal to `"1.40.1"`.
- [ ] A unit test under `core/test/` reads only that run-scoped path and fails if `release_version` is not `"1.40.1"`.
- [ ] Production files under `core/scripts/` are unchanged.
- [ ] Pre-merge archives this change. No active change path remains under `openspec/changes/` except `archive/`.
- [ ] The Pipeline reaches `pipeline:ready-to-deploy` for issue #1449.
