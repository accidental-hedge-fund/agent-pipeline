## Why

Factory Reliability Gate pack `pack-1401-pipeline-ship-1.40.1` needs one clean Pipeline item. The item is a small, run-scoped documentation fixture and a unit test that pins release `1.40.1`. This is a synthetic clean-path exercise, not a production defect and not a recovery-class change.

## What Changes

- Add a run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- Add a `node:test` unit test that reads that exact path and asserts `release_version` is `1.40.1`.
- The test fails when that field is missing or has any other value.
- Production pipeline behavior does not change: no CLI, stage, prompt, host SKILL, or merge-authority edits.
- **BREAKING:** none.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.40.1`.
- [ ] A unit test under `core/test/` reads only that run-scoped path (no other pack-run fixture directory).
- [ ] The same unit test fails if `release_version` is missing or is not `1.40.1`.
- [ ] No production module under `core/scripts/` changes.
- [ ] `cd core && npm test` includes the new test and the suite stays green.
- [ ] After any `core/` edit, `node scripts/build.mjs` keeps generated host SKILLs fresh.
- [ ] `npm run ci` from the repo root is green.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: Run-scoped Factory Reliability Gate fixture for pack `pack-1401-pipeline-ship-1.40.1`. The fixture names release `1.40.1`, and a unit test reads that exact path and fails when the version changes.

### Modified Capabilities

- None. Living `factory-reliability-gate` already requires a fixed pack and clean-item throughput. This change does not alter FRG scoring, pack templates, auto-close, or merge authority.

## Impact

- New fixture: `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- New unit test under `core/test/` using the existing `node:test` + `node:fs` `readFileSync` + `JSON.parse` pattern. No fixture-loader helper. No new dependency.
- Tests stay offline: no network, git, or subprocess.
- Does not: change production engine code, review policy, merge commands, host SKILLs, FRG pack templates, or auto-close of synthetic pack PRs.
- Class vs site: this is a pack-run clean-path fixture, not an engine-class fault. No shared classifier, recipe, gate, or controller change is in scope.
