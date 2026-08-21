## Why

Issue #1200 is the factory-gate-v1 `clean-docs` instance for pack run
`pack-1399-tugboat-ship-1.39.9` (release `1.39.9`). The pack needs one
clean Pipeline path that adds a run-scoped documentation fixture and a
unit test that pins that release. Production engine behavior stays
unchanged.

This is a template instance, not a recover mole. The class is
factory-gate-v1 `clean-docs` (`core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md`).
The shared classifier, recipe, gate, and controller stay as they are.
The next identical pack run files a new instance from that template.
It does not need a new mole issue.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json`
  whose `release_version` is `1.39.9`.
- Add a unit test that reads only that path and fails if
  `release_version` is not `1.39.9`.
- Do not change production pipeline, FRG driver, templates, or merge
  behavior. Advance still stops at `pipeline:ready-to-deploy`. The FRG
  closes the pull request and issue without merge after it records the
  run.

No **BREAKING** change.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.9`.
- [ ] A co-located unit test under `core/test/` reads only that
      run-scoped path (no other pack-run fixture directory).
- [ ] The unit test fails when `release_version` is missing or not
      `1.39.9`.
- [ ] The unit test uses no real network, git, or subprocess calls.
- [ ] Production code under `core/scripts/` is unchanged (no FRG driver,
      template, stage, or merge-surface edits).
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change if the mirror includes the new fixture or test.
- [ ] `npm run ci` is green.
- [ ] The Pipeline for #1200 reaches `pipeline:ready-to-deploy`.
- [ ] This OpenSpec change is the only active change for this issue.

## Capabilities

### New Capabilities

- `frg-pack-1399-clean-docs`: Run-scoped factory-gate `clean-docs`
  fixture and unit test for pack `pack-1399-tugboat-ship-1.39.9`. The
  fixture names release `1.39.9`. The test fails if that value changes.
  Production behavior is out of scope.

### Modified Capabilities

<!-- None. This instance does not change factory-reliability-gate, merge,
     or ship-path law. -->

## Impact

- **Tests only:** new JSON under
  `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/` and one
  co-located unit test under `core/test/`.
- **Mirror:** if `scripts/build.mjs` copies `core/test/` into `plugin/`,
  regenerate `plugin/` in the same commit. If the mirror does not copy
  tests, do not hand-edit `plugin/`.
- **Does not:** edit FRG templates, `factory-reliability-gate.ts`,
  stages, merge commands, or living factory-reliability-gate law.
- **Does not:** merge the PR. FRG closes the synthetic pull request and
  issue after it records the run.
