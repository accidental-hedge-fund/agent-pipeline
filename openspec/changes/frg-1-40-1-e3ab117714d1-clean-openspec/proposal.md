## Why

Release `1.40.1` factory-gate run `frg-1.40.1-e3ab117714d1` needs one synthetic
clean OpenSpec path observation. This change records that fixture for issue
#1593. It does not change production behavior and is not a production
self-host repair.

## What Changes

- Add one run-scoped JSON fixture at
  `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-openspec.json` with
  `release_version` exactly `1.40.1`.
- Add one executable Node unit test at
  `core/test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts` that reads
  only that fixture, parses it, and asserts the literal release value.
- Keep this OpenSpec change owned only by issue #1593. Archive destination is
  `openspec/specs/frg-1-40-1-e3ab117714d1-clean-openspec/spec.md`.
- Do not change production classifiers, recovery recipes, gates, or
  controllers.
- Do not edit another run's fixtures or another issue's OpenSpec change.

## Capabilities

### New Capabilities

- `frg-1-40-1-e3ab117714d1-clean-openspec`: Run-scoped clean OpenSpec fixture
  for pack run `frg-1.40.1-e3ab117714d1`. The fixture names release `1.40.1`.
  The change also records controller-owned lifecycle evidence that must not
  become implementer tasks.

### Modified Capabilities

None.

## Impact

- **Class vs site:** this is a clean-path observation fixture, not a
  production self-host repair. No shared classifier, recovery recipe, gate,
  or controller change is required. The next identical clean-openspec
  observation uses the same FRG exact-pair path and does not need a new mole
  issue.
- **Reuse first:** after reading in-scope test and fixture code, the first
  holding rung is Node stdlib (`node:test`, `node:assert/strict`, `node:fs`,
  `node:path`, `JSON.parse`) plus one JSON file. Do not add a fixture loader,
  helper module, or production API.
- New files only:
  `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-openspec.json` and
  `core/test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts`.
- No production `core/scripts/` behavior, host SKILL, classifier, recovery
  recipe, gate, or controller change.
- Pre-merge later archives this change into
  `openspec/specs/frg-1-40-1-e3ab117714d1-clean-openspec/spec.md` only.
- Advance, merge, deployment, and issue/PR close stay outside implementer
  work.

## Acceptance Criteria

Implementer-owned outcomes that can finish before pre-merge archive:

- [ ] `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-openspec.json`
      exists and names `release_version` exactly `1.40.1`.
- [ ] `core/test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts` exists,
      reads only that fixture, parses it, and asserts the literal release
      value `1.40.1`.
- [ ] The focused command
      `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts`
      passes.
- [ ] The same test fails if the fixture's `release_version` value changes.
- [ ] This change contains the requirement that the fixture names release
      `1.40.1` and belongs only to issue #1593.
- [ ] `openspec validate --all` passes.
- [ ] `npm run ci` passes from the repository root.
- [ ] The product diff stays inside the run-scoped fixture, the run-scoped
      test, and this OpenSpec change.

Controller-owned lifecycle evidence. These remain required acceptance
outcomes. They MUST stay unchecked here until Pipeline/FRG observes them.
They MUST NOT be copied into `tasks.md`:

- [ ] The issue receives ordinary issue-readiness admission, planning, plan
      review, implementation, and review. The fixture gets no label-only
      bypass or reduced rigor.
- [ ] Pre-merge archives this issue's OpenSpec change and leaves no foreign
      active change.
- [ ] The full Pipeline reaches `pipeline:ready-to-deploy`. Advance does not
      merge or deploy.
- [ ] After the FRG records the run, the FRG controller closes the pull
      request and issue without merge.
