## Why

Issue #1431 is the synthetic `clean-openspec` item for Factory Reliability Gate (FRG) pack run `pack-1401-pipeline-ship-1.40.1`. The pack must exercise one clean Pipeline path that authors an OpenSpec change, implements a run-scoped fixture, and archives that change. The path is a pack-instance proof. It is not a production-behavior change.

## What Changes

- Add one run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- The fixture names release `1.40.1` in field `release_version`.
- Add one unit test that reads that exact path and asserts `release_version` is `1.40.1`.
- Propose one OpenSpec requirement for that fixture value. Pre-merge archives this change.
- Do not change production pipeline, FRG scoring, merge, or ship behavior.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-openspec`: the run-scoped `clean-openspec` fixture for pack `pack-1401-pipeline-ship-1.40.1` must name release `1.40.1`, and a unit test must fail if that value changes.

### Modified Capabilities

- None. `factory-reliability-gate` already requires a clean OpenSpec pack path and post-pass close without merge. This change does not alter those requirements.

## Impact

- **Class vs site:** this is a synthetic FRG pack instance (`template_id=clean-openspec`), not a ship-path recover. No shared classifier, recipe, gate, or controller change is in scope. Production engine behavior stays unchanged. The next identical pack instance uses the same template with a new `pack_run_id` path. It does not need a mole issue.
- **Reuse first:** after reading in-scope tests, stop at the existing `fs.readFileSync` + `JSON.parse` + `fileURLToPath` pattern in `core/test/` (`js-yaml-advisory-floor.test.ts`, `version.test.ts`). Do not add a fixture loader, helper module, or production API.
- **Code:** fixture JSON under `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/`; one co-located unit test under `core/test/`. No edits under `core/scripts/`.
- **Out of scope:** production behavior; FRG scorer or pack-manifest edits; merge inside advance or loop; a second active OpenSpec change; fixtures or tests outside the run-scoped path.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` exists and is valid JSON.
- [ ] That fixture sets `release_version` to the string `1.40.1`.
- [ ] A unit test reads only that run-scoped path and fails if `release_version` is not `1.40.1`.
- [ ] The test and fixture do not read or write any other `core/test/fixtures/frg/` pack-run directory.
- [ ] Production code under `core/scripts/` does not change.
- [ ] This change directory is the only active OpenSpec change for issue #1431.
- [ ] Pre-merge archives this change into living specs and leaves no foreign active change.
- [ ] `openspec validate frg-pack-1401-clean-openspec` and `npm run ci` pass.
