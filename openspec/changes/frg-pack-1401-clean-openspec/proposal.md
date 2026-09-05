## Why

Issue #1465 is the factory-gate `clean-openspec` instance for pack run
`pack-1401-pipeline-ship-1.40.1` (release `1.40.1`). The pack must exercise one
clean Pipeline path that includes an OpenSpec change and archive. The path
needs a run-scoped fixture and one requirement that names that release.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- Add one OpenSpec requirement: that fixture SHALL set `release_version` to
  `1.40.1`.
- Add a unit test that reads only that run-scoped path and asserts
  `release_version` is `1.40.1`.
- Do not change production behavior. Do not add a fixture loader, schema, CLI
  verb, or helper.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-openspec`: the pack-1401 clean-openspec fixture names
  release `1.40.1` at the run-scoped path.

### Modified Capabilities

- (none)

## Impact

- **Reuse first:** after reading in-scope tests, stop at stdlib
  `fs.readFileSync` + `JSON.parse` and `node:test` / `node:assert/strict`.
  Existing tests already use that pattern (`core/test/version.test.ts`). Do not
  invent a fixture loader, schema registry, or FRG helper.
- **Files:** one JSON fixture under
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/`; one unit test under
  `core/test/`. No `core/scripts/` production edits.
- **OpenSpec:** this change is the only active change for #1465. Pre-merge
  archives it. Do not leave a foreign active change.
- **CLI / merge:** no new public verb. Advance still does not merge.
- **Out of scope:** production pipeline behavior; other pack-run fixtures;
  factory-reliability-gate scoring law; merging the FRG pull request.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` exists and parses as JSON.
- [ ] That fixture's `release_version` field is the string `1.40.1`.
- [ ] A unit test reads only that run-scoped path and fails if `release_version` is not `1.40.1`.
- [ ] No production module under `core/scripts/` changes behavior for this issue.
- [ ] This change (`frg-pack-1401-clean-openspec`) is the only active OpenSpec change for #1465.
- [ ] Pre-merge archives this change and leaves no foreign active change.
