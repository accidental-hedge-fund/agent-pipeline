## Why

Issue #1290 is Factory Reliability Gate (FRG) pack instance `clean-docs` for
release `1.39.15` and pack run `pack-13915-pipeline-ship-1.39.15`. The pack needs
one clean Pipeline path that lands a small documentation fixture and a pinning
test, with no production behavior change.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json`.
- Add a hermetic unit test that reads only that path and asserts
  `release_version` is the string `1.39.15`.
- Keep production code, FRG scoring, release preflight, and pack driver logic
  unchanged.
- Open a PR and advance the issue to `pipeline:ready-to-deploy`. Existing FRG
  post-pass disposition may close the PR and issue without merge.

**BREAKING:** none.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json`
      exists and declares `release_version` as the string `1.39.15`.
- [ ] A unit test loads that exact run-scoped path (no other fixture directory)
      and fails when `release_version` is not `1.39.15`.
- [ ] The implementation diff does not change production scripts, FRG scoring,
      release preflight, or pack driver pass/fail logic.
- [ ] `npm run ci` is green on the PR head.
- [ ] The issue reaches label `pipeline:ready-to-deploy`.
- [ ] This change does not add a merge path. FRG may close the PR and issue
      without merge after it records the run (existing post-pass disposition).

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `factory-reliability-gate`: ADDED requirement that the `clean-docs` pack
  instance for pack run `pack-13915-pipeline-ship-1.39.15` SHALL land the
  run-scoped fixture and pinning test above. No change to FRG scoring
  thresholds, scenario ids, evidence schema, or driver pass/fail logic.

## Impact

- **Test fixture only:** one JSON file under
  `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/` plus one
  `core/test/*.test.ts` file that reads it.
- **OpenSpec:** this change folder. Pre-merge may archive it into
  `openspec/specs/factory-reliability-gate/`.
- **Out of scope:** `core/scripts/factory-reliability-gate.ts`, release
  sub-command, FRG thresholds, scoreboard metrics, product features, auto-merge,
  review-rigor demotion, and re-implementing FRG auto-close.
- **Class vs site:** this issue is a synthetic `factory-gate` pack item
  (`template_id=clean-docs`), not an engine recover or ship-path fault. The
  class is the pack template contract (run-scoped fixture + pin test, no
  production change). This change does not add a path-local mole in the
  driver.
