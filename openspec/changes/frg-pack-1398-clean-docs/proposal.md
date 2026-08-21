## Why

Issue #1194 is the Factory Reliability Gate (FRG) `clean-docs` instance for pack
`pack-1398-tugboat-ship-1.39.8` and release `1.39.8`. The pack needs one clean
Pipeline path that adds a run-scoped documentation fixture and a unit test, with
no production-behavior change.

This is a synthetic pack instance, not an engine recover defect. Shared
classifier, recipe, gate, and controller law stay unchanged. The next identical
FRG pack uses its own `pack_run_id` path.

## What Changes

- Add JSON fixture
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`.
- The fixture names `release_version` as `1.39.8`.
- Add a unit test that reads that run-scoped path and asserts
  `release_version === "1.39.8"`. The test fails if the fixture version changes.
- Do not change production scripts, stages, FRG driver, merge, or close behavior.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field is the string `1.39.8`.
- [ ] A unit test under `core/test/` reads only that run-scoped path (it does not
      read another pack's fixture).
- [ ] That test fails if `release_version` is any value other than `1.39.8`.
- [ ] Production engine behavior is unchanged: no edits under `core/scripts/`,
      no FRG pack/template/driver change, no merge-stage or auto-merge addition.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change.
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `frg-pack-1398-clean-docs`: run-scoped FRG `clean-docs` fixture and test for
  pack `pack-1398-tugboat-ship-1.39.8`. The fixture path and `release_version`
  `1.39.8` are the contract. Production pipeline behavior is out of scope.

### Modified Capabilities

<!-- None. This instance does not change factory-reliability-gate production law. -->

## Impact

- **Tests:** new fixture
  `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` and a
  co-located unit test under `core/test/`. Tests inject no network, git, or
  subprocess. Reading the fixture file is in-process filesystem I/O of a
  repo-local file.
- **Engine:** no `core/scripts/` change. If the test lives under `core/test/`,
  run `node scripts/build.mjs` in the same change so `plugin/` stays in sync.
- **FRG close:** the FRG driver already closes the pull request and issue without
  merge after it records the run. This change does not implement that close.
- **Does not:** change production stages; add merge inside advance/loop; add
  `auto_merge`; change FRG pack templates; share a fixture path with another pack.
