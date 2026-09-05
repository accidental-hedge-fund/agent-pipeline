## Why

Factory-gate pack `pack-1401-pipeline-ship-1.40.1` (release `1.40.1`) needs one clean Pipeline path that adds a small documentation fixture and a unit test. The pack instance (#1448, template `clean-docs`) exists to exercise the Pipeline to `pipeline:ready-to-deploy` without changing production behavior.

## What Changes

- Add a run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- Add a `node:test` unit test that reads that fixture and asserts `release_version` is `1.40.1`.
- The test uses only that run-scoped path. It fails if the fixture version changes.
- No production module, CLI verb, stage, config key, or host SKILL changes.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: Run-scoped clean-docs fixture and unit test for factory-gate pack `pack-1401-pipeline-ship-1.40.1` (release `1.40.1`).

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** this is a factory-gate `clean-docs` pack instance, not a ship-path recover or engine-defect mole. It does not change a shared classifier, recipe, gate, or controller. The next identical pack instance uses the same `clean-docs` template, not this fixture.
- **Reuse first:** after reading in-scope tests, stop at existing `node:test` + `node:fs` `readFileSync` + `JSON.parse` (same pattern as `core/test/declared-dependency-grammar.test.ts` and `core/test/version.test.ts`). Do not add a fixture loader, schema, helper, or production module.
- **Code:** new files under `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/` and `core/test/` only. No edits under `core/scripts/`.
- **CLI / merge:** no new public verb. Advance still does not merge.
- **Tests:** hermetic unit test. No network, git, or subprocess.
- **Out of scope:** production behavior, FRG pack generator, host SKILL, merge, and sibling pack-run fixtures.

## Acceptance Criteria

- [ ] `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field is the string `1.40.1`.
- [ ] A unit test under `core/test/` reads that exact run-scoped path (not another pack-run directory) and asserts `release_version === "1.40.1"`.
- [ ] Changing the fixture `release_version` to any other value makes that unit test fail.
- [ ] No production file under `core/scripts/` changes as part of this issue.
- [ ] `cd core && npm test` runs the new test and the test passes with the fixture as specified.
- [ ] The full Pipeline for issue #1448 reaches `pipeline:ready-to-deploy`.
