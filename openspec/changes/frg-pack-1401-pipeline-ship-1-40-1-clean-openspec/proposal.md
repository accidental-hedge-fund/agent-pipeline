## Why

Release `1.40.1` needs a synthetic clean-path FRG fixture that proves the normal Pipeline OpenSpec lifecycle without changing production behavior. A literal, executable release assertion makes fixture drift fail deterministically, while controller evidence records the later planning, archive, ready-to-deploy, and close-without-merge observations.

## What Changes

- Add one run-scoped JSON fixture whose `release_version` is exactly `1.40.1`.
- Add one executable Node test that reads only that fixture and fails when its release value changes.
- Define the clean OpenSpec lifecycle contract for this fixture, including normal review rigor, issue-owned archival, ready-to-deploy completion without merge, and controller closure after evidence capture.
- Limit implementer work to the fixture, its test, this issue-owned OpenSpec change, and pre-archive verification. Production pipeline behavior and manual lifecycle changes remain out of scope.

## Capabilities

### New Capabilities

- `frg-clean-openspec-fixture`: Defines the release-bound fixture assertion and controller-observed clean OpenSpec lifecycle for the `pack-1401-pipeline-ship-1.40.1` run.

### Modified Capabilities

- (none)

## Impact

- Adds planning artifacts under `openspec/changes/frg-pack-1401-pipeline-ship-1-40-1-clean-openspec/`.
- Future implementation is restricted to `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` and `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-openspec.test.ts` in addition to this change.
- Reuses the existing Node test runner, JSON parsing, OpenSpec planning/archive lifecycle, normal Pipeline stages, and FRG controller evidence path. No custom runner, classifier, recovery recipe, gate, controller, or production API is introduced.
- This is a clean-path observation, not an engine self-host repair; class-versus-site recovery design does not apply because no fault is being repaired.

## Acceptance Criteria

- [ ] The run-scoped fixture exists at the exact issue-owned path and parses as JSON with `release_version` exactly `1.40.1`.
- [ ] The exact run-scoped Node test reads only that fixture, passes for `1.40.1`, and fails if the fixture's release value changes.
- [ ] The issue-owned OpenSpec change contains exactly one requirement covering the release assertion and the controller-observed clean lifecycle, and `openspec validate --all` passes before implementation completion.
- [ ] The targeted test and repository-root `npm run ci` pass without production behavior changes or edits outside the three authorized run-scoped paths.
- [ ] Controller evidence shows normal readiness, planning, plan review, implementation, and review with no label-only bypass or reduced rigor.
- [ ] Controller evidence shows pre-merge archived only this issue's OpenSpec change and left no foreign active change.
- [ ] Controller evidence shows the Pipeline reached `pipeline:ready-to-deploy` without advance merging or deploying.
- [ ] After recording the run, the FRG controller closes the pull request and issue without merge.
