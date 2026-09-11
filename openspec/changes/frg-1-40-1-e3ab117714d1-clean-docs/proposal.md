## Why

Factory Reliability Gate (FRG) pack run `frg-1.40.1-e3ab117714d1` needs one synthetic
clean-docs fixture for Pipeline release `1.40.1`. The fixture proves run identity
through a repeatable unit test. The ordinary Pipeline lifecycle is observed later
by the FRG controller. This issue does not change production behavior.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json` with
  `release_version` exactly `1.40.1`.
- Add one executable Node unit test at
  `core/test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts` that reads only that
  fixture, parses it, and asserts the literal release value.
- Add one issue-owned OpenSpec capability whose living-spec destination is
  `openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`.
- Do not change production behavior, classifiers, recovery recipes, gates, or
  controllers.
- Do not merge, deploy, or close the pull request from advance or from
  implementer work.

## Capabilities

### New Capabilities

- `frg-1-40-1-e3ab117714d1-clean-docs`: run-scoped clean-docs fixture identity
  for pack run `frg-1.40.1-e3ab117714d1` and release `1.40.1`, plus the
  controller-owned ordinary-lifecycle obligations that remain required
  acceptance evidence after implementation.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** this is a clean-path observation fixture, not a production
  self-host repair. No shared classifier, recovery recipe, gate, or controller
  change is required. The next identical clean-docs observation uses the same
  FRG exact-pair path and does not need a new mole issue.
- **Reuse first:** after reading in-scope test and fixture code, the first
  holding rung is Node stdlib (`node:test`, `node:fs`, `JSON.parse`) plus one
  JSON file. Do not add a fixture loader, helper module, or production API.
- **Product files:** only
  `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json` and
  `core/test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts`.
- **OpenSpec:** this change directory only. Pre-merge archives into
  `openspec/specs/frg-1-40-1-e3ab117714d1-clean-docs/spec.md`.
- **Out of scope:** production behavior; merge; deployment; release; manual
  lifecycle-state changes; another run's fixtures; another issue's OpenSpec
  change.

## Acceptance Criteria

Implementer-owned (falsifiable before pre-merge archive):

- [ ] `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json` exists
      and its parsed `release_version` is exactly `1.40.1`.
- [ ] `core/test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts` exists, reads
      only that fixture path, parses the JSON, and asserts the literal release
      value `1.40.1`.
- [ ] That unit test fails if the fixture's `release_version` is changed.
- [ ] `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-e3ab117714d1-clean-docs.test.ts`
      exits 0 against the fixture above.
- [ ] `npm run ci` from the repository root exits 0.
- [ ] The product diff contains no files outside the two run-scoped paths
      above and this issue's OpenSpec change.
- [ ] `tasks.md` lists only implementer-owned work and verification that can
      finish before the pre-merge archive.

Controller-owned lifecycle evidence (required acceptance; not `tasks.md` items;
do not check these before they occur):

- [ ] The issue receives normal issue-readiness admission, planning, plan
      review, implementation, and review. The fixture gets no label-only
      bypass or reduced rigor.
- [ ] Pre-merge archives this issue's OpenSpec change and leaves no foreign
      active change.
- [ ] The full Pipeline reaches `pipeline:ready-to-deploy`. Advance does not
      merge or deploy.
- [ ] After the FRG records the run, the FRG controller closes the pull
      request and issue without merge.
