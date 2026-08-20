## Why

Issue #1157 is the Factory Reliability Gate (FRG) `clean-docs` instance for pack
`pack-1395-tugboat-ship-1.39.5` on release `1.39.5`. The pack needs one clean
Pipeline path that adds a small run-scoped documentation fixture and a unit
test. The path must not change production behavior.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
- Add a unit test that reads only that fixture and asserts
  `release_version` is `1.39.5`.
- Keep production engine, CLI, stage, and plugin behavior unchanged.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.5`.
- [ ] A unit test under `core/test/` reads that exact run-scoped path and
      asserts `release_version === "1.39.5"`.
- [ ] The unit test fails when `release_version` is missing or is any
      other value (for example `1.39.4`).
- [ ] The fixture and test do not read or write any other
      `core/test/fixtures/frg/<pack_run_id>/` directory.
- [ ] Production source under `core/scripts/`, `hosts/`, and `plugin/` is
      unchanged.
- [ ] `cd core && npm test` includes the new test and the suite passes.
- [ ] `npm run ci` from the repo root exits 0.
- [ ] The Pipeline for issue #1157 reaches `pipeline:ready-to-deploy`.
- [ ] After the run is recorded, FRG closes the pull request and issue
      without merge.

## Capabilities

### New Capabilities

- `frg-pack-1395-clean-docs`: Run-scoped `clean-docs` fixture and unit test
  for pack `pack-1395-tugboat-ship-1.39.5` on release `1.39.5`.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** This issue is a synthetic FRG pack instance
  (`template_id=clean-docs`, `pack_run_id=pack-1395-tugboat-ship-1.39.5`).
  It is not an engine-dogfood recover or ship-path fault. There is no class
  defect to fix. No shared classifier, recipe, gate, or controller changes.
  The next identical pack instance uses the same `clean-docs` template, not
  a mole issue.
- **Primary files:** `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
  and a co-located unit test under `core/test/`.
- **Plugin mirror:** Not required. `scripts/build.mjs` copies `core/scripts`,
  `core/profiles`, and `core/package*.json` only. It does not copy
  `core/test/`.
- **Out of scope:** production behavior; FRG driver or pack-template edits;
  merge; other pack templates (`clean-openspec`); other pack run ids.
