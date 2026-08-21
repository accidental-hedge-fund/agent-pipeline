## Why

Factory Reliability Gate (FRG) pack `pack-13910-tugboat-ship-1.39.10` needs one clean Pipeline
item for release `1.39.10`. Issue #1207 is that item: a run-scoped documentation fixture and a
unit test that pins the fixture's `release_version`. Production pipeline behavior does not change.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json`.
- Add a co-located unit test that reads only that path and asserts
  `release_version` is `1.39.10`.
- Do not change production scripts, stages, prompts, CLI, or FRG driver behavior.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json` exists and is
      valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.10`.
- [ ] A unit test under `core/test/` reads that same run-scoped path (no other pack-run directory)
      and fails when `release_version` is not `1.39.10`.
- [ ] Production code under `core/scripts/` is unchanged.
- [ ] `npm run ci` is green. `plugin/` is regenerated only if a `core/` edit requires it.

## Capabilities

### New Capabilities

- `frg-clean-docs-pack-13910`: run-scoped clean-docs fixture and unit-test contract for FRG pack
  `pack-13910-tugboat-ship-1.39.10` (release `1.39.10`).

### Modified Capabilities

<!-- None. This change does not alter factory-reliability-gate driver law or other living specs. -->

## Impact

- **Tests / fixtures only:** `core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json`
  and a new or extended `core/test/` unit test that reads it.
- **Not in scope:** `core/scripts/` production behavior, FRG scoring, merge, and other pack-run
  fixture trees.
- After archive, living spec `openspec/specs/frg-clean-docs-pack-13910/`.
