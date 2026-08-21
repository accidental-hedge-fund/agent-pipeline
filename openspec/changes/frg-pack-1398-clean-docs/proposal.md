## Why

Factory Reliability Gate (FRG) pack `pack-1398-tugboat-ship-1.39.8` needs one clean Pipeline path for release `1.39.8`. Issue #1188 is that path: a run-scoped documentation fixture plus a unit test. Production pipeline behavior stays unchanged.

## What Changes

- Add a run-scoped JSON fixture at `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` whose `release_version` is `1.39.8`.
- Add a unit test that reads only that path and fails when `release_version` is not `1.39.8`.
- Do not change production scripts, stages, prompts, or FRG driver law.

## Capabilities

### New Capabilities

- `frg-pack-1398-clean-docs`: Run-scoped clean-docs fixture and pin test for FRG pack `pack-1398-tugboat-ship-1.39.8` (release `1.39.8`).

### Modified Capabilities

<!-- None. This is instance work for one FRG pack item. It does not change factory-reliability-gate driver law. -->

## Impact

- New files under `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/` and `core/test/`.
- No edits under `core/scripts/`.
- No `plugin/` regeneration (tests are not part of the generated mirror).
- No merge, auto-merge, or production runtime change.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` exists and parses as JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.8`.
- [ ] The unit test reads that exact run-scoped path. It does not read another pack directory.
- [ ] Changing the fixture `release_version` to any other string makes that unit test fail.
- [ ] Production files under `core/scripts/` have an empty diff for this issue.
- [ ] `cd core && npm test` is green with the new test included.
- [ ] The issue Pipeline reaches `pipeline:ready-to-deploy`.
- [ ] After the run is recorded, FRG closes the pull request and issue without merge.
