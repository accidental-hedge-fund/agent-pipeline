## Why

Issue #1169 is the Factory Reliability Gate (FRG) `clean-docs` instance for pack run
`pack-1396-tugboat-ship-1.39.6` and release `1.39.6`. The pack needs one clean Pipeline path
that adds a run-scoped documentation fixture and a unit test, with no production behavior
change.

This is a synthetic pack instance (`template_id=clean-docs`), not an engine-recovery mole.
Shared classifier, recipe, gate, and controller law stay unchanged. The next pack run files a
new instance from the same template.

## What Changes

- Add JSON fixture `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json`.
- Add a unit test that reads that run-scoped path and asserts `release_version` is `1.39.6`.
- Do not change production runtime, CLI, stage, or FRG driver behavior.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.6`.
- [ ] A unit test under `core/test/` reads only that run-scoped fixture path (no other pack-run directory).
- [ ] That test fails when `release_version` is missing or is not `1.39.6`.
- [ ] Production code under `core/scripts/` and host packaging is unchanged.
- [ ] `cd core && npm test` includes the new test and the suite passes.
- [ ] `npm run ci` is green (including `build.mjs --check` with no `plugin/` edit, because core production files are untouched).
- [ ] This issue's Pipeline run reaches `pipeline:ready-to-deploy`.
- [ ] After FRG records the pack run, FRG closes this pull request and issue without merge (existing FRG disposition; this change does not add a merge path).

## Capabilities

### New Capabilities

- `frg-pack-1396-tugboat-ship-clean-docs`: run-scoped clean-docs fixture contract for pack
  `pack-1396-tugboat-ship-1.39.6` — path, `release_version` value, unit-test binding, and
  no production-behavior change.

### Modified Capabilities

- None. Living `factory-reliability-gate` already requires synthetic pack items to reach
  ready-to-deploy and to close without merge after a recorded run. This instance does not
  change that law.

## Impact

- **Tests only:** `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json` and a
  co-located unit test under `core/test/`.
- **Not impacted:** `core/scripts/`, `hosts/`, `plugin/` (no core production edit, so no
  mirror regen), FRG driver, merge commands, and living `factory-reliability-gate` requirements.
- **Process:** pre-merge archives this OpenSpec change on the PR branch. FRG then closes the
  PR without merging, so main does not keep the archive.
