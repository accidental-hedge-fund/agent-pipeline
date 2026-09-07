## Why

Pipeline release `1.40.1` needs one synthetic `clean-docs` conformance instance whose checked-in identity can be verified independently of production behavior. The fixture supplies repeatable implementation evidence, while the existing FRG lifecycle records whether the ordinary issue-to-ready-to-deploy path remains healthy.

## What Changes

- Add the run-scoped `clean-docs.json` fixture for `pack-1401-pipeline-ship-1.40.1` with `release_version` exactly `1.40.1`.
- Add one executable Node test that reads only that fixture and fails when its literal release value changes.
- Preserve the ordinary issue-readiness, planning, plan-review, implementation, review, pre-merge archive, ready-to-deploy, and post-recording cleanup obligations as controller-owned lifecycle evidence rather than pre-archive implementation tasks.
- Make no production behavior, classifier, recovery recipe, gate, controller, merge, deployment, or manual lifecycle-state change.

## Acceptance Criteria

- [ ] The exact run-scoped fixture exists and contains `release_version` equal to `1.40.1`.
- [ ] The exact run-scoped Node test reads only that fixture, passes for `1.40.1`, and fails if the fixture's release value changes.
- [ ] The focused test command passes.
- [ ] The repository-wide `npm run ci` gate passes.
- [ ] Pipeline/FRG lifecycle evidence shows ordinary readiness, planning, plan review, implementation, and review with no label-only bypass or reduced rigor.
- [ ] If OpenSpec planning is used, pre-merge archives only this issue's change and leaves no foreign active change.
- [ ] Pipeline reaches `pipeline:ready-to-deploy` without advance merging or deploying.
- [ ] After recording the run, the FRG controller closes the pull request and issue without merge.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `factory-reliability-gate`: Bind the `pack-1401-pipeline-ship-1.40.1` clean-docs fixture to its exact release identity and preserve its ordinary controller-owned lifecycle evidence.

## Impact

- Adds only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`, `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts`, and this OpenSpec change.
- Reuses the existing Node test runner, FRG lifecycle contract, and Pipeline state machine; it adds no dependency or production API.
