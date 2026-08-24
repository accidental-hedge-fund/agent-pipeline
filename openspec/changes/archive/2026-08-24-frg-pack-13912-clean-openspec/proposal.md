## Why

Factory Reliability Gate (FRG) pack `pack-13912-tugboat-ship-1.39.12` must exercise
one clean Pipeline path that carries a real OpenSpec change through archive.
Issue #1231 is that synthetic `clean-openspec` item for release `1.39.12`.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`.
- Add one OpenSpec requirement that the fixture names release `1.39.12`.
- Add a unit test that reads only that run-scoped path and fails when
  `release_version` is not `1.39.12`.
- Do not change production behavior.

**BREAKING:** none.

Non-goals: production FRG driver or pack-manifest edits; merge inside
advance/loop; a second active OpenSpec change; fixtures under any other
`pack_run_id` path.

## Acceptance criteria

- [x] `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
      exists and is valid JSON.
- [x] That fixture object's `release_version` field is the exact string
      `1.39.12`.
- [x] A unit test under `core/test/` reads only that run-scoped path and fails
      if `release_version` is not `1.39.12`.
- [x] No file under `core/scripts/` changes. Runtime pipeline behavior stays
      the same.
- [x] The only active OpenSpec change for this issue is
      `frg-pack-13912-clean-openspec`.
- [ ] Pre-merge archives that change into living specs and leaves no foreign
      active change under `openspec/changes/` (other than archive).
- [ ] The issue reaches `pipeline:ready-to-deploy`. FRG close-without-merge is
      an FRG driver outcome, not this change's implementation.

## Capabilities

### New Capabilities

- `frg-pack-13912-clean-openspec`: Run-scoped FRG `clean-openspec` fixture for
  pack `pack-13912-tugboat-ship-1.39.12` that MUST name release `1.39.12`,
  plus the unit test that verifies that value.

### Modified Capabilities

<!-- None. This is pack-run fixture law, not a change to factory-reliability-gate
     production requirements. -->

## Impact

- **Fixture:** `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
- **Test:** a new `core/test/*.test.ts` file that reads that path only
- **Specs:** new capability `frg-pack-13912-clean-openspec` (archived at
  pre-merge into `openspec/specs/`)
- **Does not:** edit `core/scripts/`; regenerate `plugin/` for production
  logic; add an `auto_merge` key or merge stage; stack a second OpenSpec
  change
