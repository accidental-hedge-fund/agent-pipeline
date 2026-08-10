## Why

Factory Reliability Gate (FRG) pack run `frg-1-33-0-f66627485c58a658c444ae3b` for release `1.33.0` needs one clean Pipeline item that exercises planning through `pipeline:ready-to-deploy` without changing product behavior. A run-scoped documentation fixture plus a unit test that pins `release_version` proves the clean-docs template path works for this pack run.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`
  with `release_version` equal to `1.33.0`.
- Add a unit test that reads only that run-scoped path and asserts
  `release_version === "1.33.0"` (the test fails if the fixture version changes).
- Do **not** change production pipeline stages, CLI behavior, merge authority, or FRG driver logic.

## Acceptance Criteria

- [ ] Fixture exists only under
      `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`
      (no shared/non-run-scoped FRG clean-docs path for this item).
- [ ] Fixture JSON includes `release_version` with value `1.33.0`.
- [ ] A unit test loads the fixture from that exact run-scoped path and asserts
      `release_version` is `1.33.0`.
- [ ] Changing the fixture `release_version` away from `1.33.0` makes that unit test fail.
- [ ] No production runtime modules under `core/scripts/` (excluding tests/fixtures) change behavior for this issue.
- [ ] `npm run ci` is green after implementation (including mirror check when `core/` changes).
- [ ] The issue reaches `pipeline:ready-to-deploy` (FRG may later close PR/issue without merge after recording the run; that close path is out of this change's code scope).

## Capabilities

### New Capabilities

- `frg-clean-docs-fixture`: Run-scoped clean-docs FRG fixture layout and unit-test contract for pack runs (path isolation, pinned `release_version`, no production behavior change).

### Modified Capabilities

_(none)_

## Impact

- `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/` — new fixture directory and `clean-docs.json`.
- `core/test/` — new co-located unit test for the fixture.
- No production stage, config, or merge-path impact.
- Living spec `openspec/specs/frg-clean-docs-fixture/` after archive.
