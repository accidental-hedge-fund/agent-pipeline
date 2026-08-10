## Why

Factory Reliability Gate (FRG) release `1.33.0` needs a synthetic pack item that exercises one
clean Pipeline path with a real OpenSpec change and pre-merge archive. Issue #933 is that pack
item (`template_id=clean-openspec`,
`pack_run_id=frg-1-33-0-d5d716355f2ed48d04aa8dde`). Without a focused OpenSpec change, fixture,
and unit test scoped only to this run, the pack cannot prove OpenSpec propose → implement → archive
hygiene on the way to `pipeline:ready-to-deploy`.

## What Changes

- Add a **run-scoped JSON fixture** at
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json` that names
  release version `1.33.0` (and identifies this pack run).
- Add **one OpenSpec requirement** (new capability) stating that this fixture MUST name release
  `1.33.0`.
- Add a **unit test** that loads only that run-scoped path and asserts the fixture’s release
  version is `1.33.0`.
- **No production behavior changes** — no engine stage, CLI, config, or FRG driver edits beyond
  test fixture + test + OpenSpec artifacts.

## Acceptance Criteria

- [ ] Exactly one active OpenSpec change exists for this issue (`frg-1-33-0-clean-openspec`); it
      is not shared with other issues or pack templates.
- [ ] File
      `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json` exists and
      its release version field is the string `1.33.0`.
- [ ] A unit test under `core/test/` reads **only** that run-scoped fixture path and fails if the
      release version is not `1.33.0`.
- [ ] No production runtime modules under `core/scripts/` (excluding tests/fixtures) change
      behavior for this issue.
- [ ] Pre-merge archives this OpenSpec change; no foreign active OpenSpec change remains on the
      branch after archive.
- [ ] The issue reaches `pipeline:ready-to-deploy` with a green full gate (`npm run ci`).
- [ ] After FRG records the run, the synthetic PR and issue are closed without merge (existing
      FRG post-pass disposition; not reimplemented here).

## Capabilities

### New Capabilities

- `frg-clean-openspec-run-fixture`: Contract for the run-scoped `clean-openspec` JSON fixture used
  by FRG pack run `frg-1-33-0-d5d716355f2ed48d04aa8dde` — the fixture MUST name release `1.33.0`
  and live only under that pack-run path.

### Modified Capabilities

<!-- None — this synthetic item does not change production FRG driver requirements. -->

## Impact

- **Specs:** new living capability `frg-clean-openspec-run-fixture` after pre-merge archive (on
  this branch only until/unless the synthetic PR is merged; FRG closes without merge by design).
- **Code (implementation step, not this proposal):** one JSON fixture under
  `core/test/fixtures/frg/<pack_run_id>/`, one co-located unit test under `core/test/`. No
  `plugin/` mirror regeneration expected unless a core source file outside tests is touched
  (should not be).
- **Does not:** change FRG scoring, pack templates, advance stages, merge authority, or any
  operator-facing CLI.
- **Siblings:** FRG pack `factory-gate-v1`, release `1.33.0`, pack run
  `frg-1-33-0-d5d716355f2ed48d04aa8dde`, template `clean-openspec` (#933).
