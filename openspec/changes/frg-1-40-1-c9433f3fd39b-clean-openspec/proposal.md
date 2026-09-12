## Why

Release `1.40.1` needs one synthetic clean-openspec fixture for pack run
`frg-1.40.1-c9433f3fd39b`. The fixture proves the ordinary OpenSpec planning
and archive path. It does not change production behavior.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json` with
  `release_version` exactly `1.40.1`.
- Add one executable Node unit test at
  `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts`. The test
  reads only that fixture, parses it, and asserts the literal release value.
- Author this issue-owned OpenSpec change only. The change carries one
  product requirement that the fixture names release `1.40.1`, plus
  controller-owned lifecycle obligations in requirements and scenarios.
- Do not edit production classifiers, recovery recipes, gates, controllers,
  another run's fixtures, or another issue's OpenSpec change.

## Capabilities

### New Capabilities

- `frg-1-40-1-c9433f3fd39b-clean-openspec`: Run-scoped clean-openspec
  fixture for pack run `frg-1.40.1-c9433f3fd39b`. It names release `1.40.1`
  and records the ordinary OpenSpec lifecycle that the FRG controller
  observes. The only living-spec destination is
  `openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`.

### Modified Capabilities

- None. This fixture does not change production `factory-reliability-gate`
  or other living capabilities.

## Acceptance Criteria

Implementer-owned outcomes (finish before pre-merge archive):

- [ ] `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json`
      exists and its parsed `release_version` is exactly `1.40.1`.
- [ ] `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts` exists,
      reads only that fixture, parses it, and asserts the literal value
      `1.40.1`.
- [ ] The unit test fails when the fixture `release_version` is not `1.40.1`.
- [ ] This OpenSpec change belongs only to issue #1601 and contains one
      product requirement that the fixture names release `1.40.1`.
- [ ] `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts`
      passes.
- [ ] `openspec validate --all` passes from the repository root.
- [ ] `npm run ci` passes from the repository root.
- [ ] The product diff stays inside the three run-scoped paths named above
      and this change directory. Production behavior is unchanged.

Controller-owned lifecycle evidence (required, not `tasks.md` items):

- [ ] The issue receives ordinary issue-readiness admission, planning, plan
      review, implementation, and review. The fixture gets no label-only
      bypass or reduced rigor.
- [ ] Pre-merge archives this issue's OpenSpec change and leaves no foreign
      active change. The living spec lands only at
      `openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`.
- [ ] The full pipeline reaches `pipeline:ready-to-deploy`. Advance does not
      merge or deploy.
- [ ] After the FRG records the run, the FRG controller closes the pull
      request and issue without merge.

## Impact

- New files only: the JSON fixture, the unit test, and this OpenSpec
  change. After archive, the living spec is
  `openspec/specs/frg-1-40-1-c9433f3fd39b-clean-openspec/spec.md`.
- No production engine, classifier, recovery recipe, gate, controller,
  merge, deploy, or release change.
- No new helper, wrapper, or test harness. The unit test uses existing
  `node:test`, `node:assert/strict`, and `fs`/`path` reads.
