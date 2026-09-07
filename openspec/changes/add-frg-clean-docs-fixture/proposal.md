## Why

The release 1.40.1 Factory Reliability Gate needs a small, run-bound clean-docs item that proves the normal issue-to-ready-to-deploy path without changing production behavior. A literal fixture assertion supplies falsifiable evidence that the pack ran against the intended release.

## What Changes

- Add one JSON fixture beneath the exact `pack-1401-pipeline-ship-1.40.1` FRG run directory.
- Add one unit test that reads that run-scoped fixture and requires its `release_version` to equal `1.40.1`.
- Keep production CLI behavior and non-run-scoped fixtures unchanged.
- Exercise the ordinary Pipeline lifecycle through `pipeline:ready-to-deploy`; after the run is recorded, the FRG closes the pull request and issue without merging.

## Acceptance Criteria

- [ ] `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and records `release_version` as `1.40.1`.
- [ ] A unit test reads only that run-scoped fixture path and passes when its `release_version` is `1.40.1`.
- [ ] Changing the fixture's `release_version` away from `1.40.1` makes the unit test fail.
- [ ] No production behavior changes.
- [ ] The issue reaches `pipeline:ready-to-deploy` through the full Pipeline.
- [ ] After recording the run, the FRG closes the pull request and issue without merging the pull request.

## Capabilities

### New Capabilities

- `frg-clean-docs-fixture`: Defines the run-scoped release-version fixture and its executable assertion for this clean-docs FRG item.

### Modified Capabilities

None.

## Impact

The change is limited to a new file under `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/`, one `core/test/*.test.ts` file, and this OpenSpec change. It adds no dependency, API, CLI, host wrapper, generated artifact, or production-code modification.
