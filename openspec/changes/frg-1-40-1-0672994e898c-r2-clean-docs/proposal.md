## Why

Release `1.40.1` exact-candidate FRG pack run `frg-1.40.1-0672994e898c-r2` needs one ordinary clean-docs fixture so the controller can observe a clean Pipeline lifecycle. The fixture proves identity of release `1.40.1`. It does not change production behavior.

## What Changes

- Add one run-scoped JSON fixture at `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json` with `release_version` exactly `1.40.1`.
- Add one executable Node unit test at `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts`. The test reads only that fixture, parses it, and asserts the literal release value. The test fails if that value changes.
- Keep this issue's OpenSpec change under `openspec/changes/frg-1-40-1-0672994e898c-r2-clean-docs/`. The only living-spec destination is `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-docs/spec.md`.
- Do not change production behavior, classifiers, recovery recipes, gates, or controllers.
- Do not merge, deploy, release, or change lifecycle state by hand.

**BREAKING:** none.

## Acceptance criteria

Implementer-owned (checkable before pre-merge archive):

- [ ] `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json` exists and its `release_version` is exactly `1.40.1`.
- [ ] `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` exists, reads only that fixture, parses it, and asserts the literal release value `1.40.1`.
- [ ] `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` exits 0.
- [ ] The same test fails if the fixture `release_version` is changed to any other value.
- [ ] `npm run ci` from the repository root exits 0.
- [ ] The product diff stays inside the run-scoped fixture, this test, and this OpenSpec change. It does not edit production behavior or another run's files.

Controller-owned lifecycle evidence (required, but do not check during implementation):

- [ ] The issue receives normal issue-readiness admission, planning, plan review, implementation, and review. The fixture gets no label-only bypass or reduced rigor.
- [ ] Pre-merge archives this issue's OpenSpec change and leaves no foreign active change. The living spec is `openspec/specs/frg-1-40-1-0672994e898c-r2-clean-docs/spec.md`.
- [ ] The full Pipeline reaches `pipeline:ready-to-deploy`. Advance does not merge or deploy.
- [ ] After the FRG records the run, the FRG controller closes the pull request and issue without merge.

## Capabilities

### New Capabilities

- `frg-1-40-1-0672994e898c-r2-clean-docs`: Run-scoped clean-docs fixture identity for pack run `frg-1.40.1-0672994e898c-r2` and the ordinary Pipeline lifecycle that the FRG controller later observes.

### Modified Capabilities

- (none)

## Impact

- New files only: the run-scoped JSON fixture, the matching Node test, and this OpenSpec change.
- Reuse the existing `node:test` / `node:fs` / `JSON.parse` pattern already used under `core/test/`. Do not add a helper, schema, or production module.
- Host SKILLs, `core/scripts/`, classifiers, recovery recipes, gates, and controllers stay unchanged.
- Advance, loop, and this fixture never merge or deploy.
