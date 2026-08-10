## Why

Factory Reliability Gate pack `factory-gate-v1` for release `1.33.0` (run
`frg-1-33-0-d5d716355f2ed48d04aa8dde`) needs one clean Pipeline path that lands a
small documentation-style JSON fixture plus a unit test. The path proves
fixture isolation and version pin without changing production behavior.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`
  that names `release_version` as `1.33.0`.
- Add a unit test that reads only that run-scoped fixture path and asserts
  `release_version === "1.33.0"`.
- Leave production pipeline stages, config, and runtime behavior unchanged.

## Capabilities

### New Capabilities

- `frg-clean-docs-fixture`: Run-scoped FRG clean-docs JSON fixture and unit test
  contract for pack run `frg-1-33-0-d5d716355f2ed48d04aa8dde` (release `1.33.0`).

### Modified Capabilities

- (none)

## Impact

- `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json` (new)
- `core/test/` unit test file that loads that fixture only (new)
- No `core/scripts/` production edits; no `plugin/` regeneration required unless
  a mirror-adjacent file is touched (none expected)
- FRG pack item #932 uses this change as its clean-docs path through the full
  Pipeline to `pipeline:ready-to-deploy`; FRG post-pass closes the PR and issue
  without merge after it records the run

## Acceptance Criteria

- [ ] Fixture file exists only under
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`
  (no other pack-run directory for this item).
- [ ] Fixture JSON includes `release_version` with exact value `1.33.0`.
- [ ] A unit test loads that run-scoped path (not a shared/global fixture path)
  and asserts `release_version` equals `1.33.0`.
- [ ] Changing the fixture's `release_version` to any other string causes that
  unit test to fail.
- [ ] Production pipeline behavior is unchanged (no stage, config, or runtime
  edits required for this item).
- [ ] The Pipeline reaches `pipeline:ready-to-deploy` for issue #932.
- [ ] After FRG records the run, the FRG closes the pull request and issue
  without merge (existing FRG auto-close; not introduced by this change).
