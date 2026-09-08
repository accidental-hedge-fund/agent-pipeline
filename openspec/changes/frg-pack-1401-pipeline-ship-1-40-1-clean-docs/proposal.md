## Why

Release `1.40.1` needs one synthetic `clean-docs` fixture that proves the ordinary Pipeline
lifecycle against an exact, run-bound release value. This is clean-path conformance evidence, not
a production defect or self-host recovery, so its implementation must remain limited to the
fixture and the executable regression test while later lifecycle observations remain
controller-owned.

## What Changes

- Add the run-scoped JSON fixture
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with
  `release_version` exactly `1.40.1`.
- Add the run-scoped executable Node test
  `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts`, which reads only that fixture,
  parses it, and asserts the literal release value.
- Preserve ordinary issue-readiness, planning, plan review, implementation, review, OpenSpec
  archive, and ready-to-deploy behavior for this fixture; no label-only bypass or reduced rigor is
  introduced.
- Keep the later ready-to-deploy and FRG close-without-merge observations as controller-owned
  lifecycle evidence, outside the implementer checklist.
- Make no production behavior, classifier, recovery recipe, gate, controller, merge, deployment,
  release, or manual lifecycle-state change.

## Acceptance Criteria

- [ ] The exact run-scoped fixture exists and parses as JSON with `release_version` equal to the
      string `1.40.1`.
- [ ] The exact run-scoped Node test reads only that fixture and asserts the literal value
      `1.40.1`.
- [ ] The targeted Node test passes with the fixture unchanged and fails when the fixture's
      `release_version` differs from `1.40.1`.
- [ ] `npm run ci` passes from the repository root with no production or out-of-scope file changes.
- [ ] Pipeline/FRG lifecycle evidence records ordinary admission, planning, plan review,
      implementation, and review without a label-only bypass or reduced rigor.
- [ ] Pre-merge archives this issue's OpenSpec change without leaving a foreign active change.
- [ ] The ordinary Pipeline reaches `pipeline:ready-to-deploy` without merge or deployment.
- [ ] After recording the run, the FRG controller closes the pull request and issue without merge.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `factory-reliability-gate`: Add the release- and run-specific `clean-docs` fixture contract and
  preserve its implementer/controller lifecycle evidence partition.

## Impact

- **Implementation scope:** exactly the fixture and test paths above, plus this issue's OpenSpec
  change while it is active.
- **Runtime/API/dependencies:** none; the test uses Node's existing test and assertion facilities.
- **Pipeline behavior:** unchanged. Advance still stops at `pipeline:ready-to-deploy`; merge,
  deployment, release, lifecycle state mutation, and post-run cleanup are not implementation work.
