## Why

The local test gate (#15) ran only `npm run test` on issue #45, but this repo's CI also runs `node scripts/build.mjs --check` (plugin mirror sync); the stale mirror was committed, `npm test` passed, and the PR was opened — only to be blocked at pre-merge when CI caught the divergence. The gate's auto-detection correctly identifies the package `test` script but has no awareness of extra CI steps, so generated-artifact staleness can silently escape to CI.

## What Changes

- **Apply the fix to this repo:** set `test_gate.command: "npm test && node scripts/build.mjs --check"` in `.github/pipeline.yml` so the gate runs agent-pipeline's full CI command locally.
- **Document the pattern:** add a README section (and inline pipeline.yml comment) explaining that if a repo's CI does more than its `test` script, the operator must set `test_gate.command` to cover the additional steps.
- **Add a regression test:** extend `testgate.test.ts` with a test that verifies a stale generated artifact (simulated via a dirty worktree after the test command runs) is caught by the gate rather than escaping to CI.

## Capabilities

### New Capabilities

- `test-gate-ci-parity`: Requirement that the test gate command covers the repo's full CI surface — either via explicit `test_gate.command` config or documented guidance to operators. Introduces the invariant that a gate pass must imply a CI pass for the repo's known CI steps.

### Modified Capabilities

<!-- No existing spec-level capabilities change; this is additive config + docs + test. -->

## Impact

- `.github/pipeline.yml` — adds `test_gate.command` override for this repo.
- `README.md` — new sub-section under the test/build gate documentation.
- `core/test/testgate.test.ts` — one new regression test case.
- No changes to `core/scripts/testgate.ts` logic (the config field already exists; this change wires it up and documents it).
