## Why

Issue #1230 is a factory-gate `clean-docs` pack instance for pack run
`pack-13912-tugboat-ship-1.39.12` (release `1.39.12`). The Factory Reliability
Gate (FRG) needs one clean Pipeline path that lands a small documentation
fixture and a unit test. Production pipeline behavior does not change.

This is synthetic pack work, not an engine defect. Shared classifier, recipe,
gate, or controller law does not change. The next identical `clean-docs` pack
instance uses the same template and does not need a new mole issue.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json`.
- The fixture names `release_version` as `1.39.12`.
- Add a unit test that reads that exact path and fails if `release_version` is
  not `1.39.12`.
- Do not change production scripts, CLI, stages, or merge behavior.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json`
      exists and parses as JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.12`.
- [ ] A unit test in `core/test/` reads only that run-scoped path (no other
      pack-run fixture path).
- [ ] That test fails when the fixture's `release_version` is not `1.39.12`.
- [ ] Production pipeline behavior is unchanged: no edits under `core/scripts/`,
      `hosts/`, or generated `plugin/` for this change.
- [ ] `npm run ci` is green.
- [ ] The issue's Pipeline run reaches `pipeline:ready-to-deploy`.
- [ ] FRG close-without-merge of the pack PR and issue remains existing
      factory-gate hygiene. This change does not add merge authority.

## Capabilities

### New Capabilities

- `frg-pack-13912-clean-docs`: Run-scoped clean-docs fixture and unit test for
  pack run `pack-13912-tugboat-ship-1.39.12` (release `1.39.12`). The fixture
  pins `release_version`. The test fails if that value changes. Production
  behavior stays unchanged.

### Modified Capabilities

<!-- None. This pack instance does not change factory-gate driver, close-without-merge, or merge law. -->

## Impact

- **Tests only:** `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json`
  and a co-located unit test under `core/test/`.
- **Not affected:** `core/scripts/`, host packaging, `plugin/` mirror, merge
  commands, FRG driver scoring, or auto-close law.
- **Plugin rebuild:** not required. `scripts/build.mjs` copies `core/scripts`
  and `core/profiles`, not `core/test/`.
