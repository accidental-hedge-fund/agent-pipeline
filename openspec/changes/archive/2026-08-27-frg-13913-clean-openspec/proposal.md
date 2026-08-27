## Why

Issue #1256 is the Factory Reliability Gate (FRG) `clean-openspec` item for
release `1.39.13` and pack run
`pack-13913-release-v1.39.13-frg-20260827-1530`. The pack must exercise one
clean Pipeline path that authors an OpenSpec change, implements a run-scoped
fixture plus test, and archives that change. No production engine behavior
changes.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json`.
- The fixture SHALL name release `1.39.13` in field `release_version`.
- Add a unit test that reads only that run-scoped path and fails when
  `release_version` is not `1.39.13`.
- Propose one OpenSpec requirement for that fixture contract.
- Do not change production runtime, CLI, stages, config, or review policy.

**BREAKING:** none.

Non-goals: production behavior; other FRG templates (`clean-docs`); other pack
runs; merge inside advance/loop; extra fixtures or tests outside the
run-scoped path.

## Acceptance criteria

- [ ] File
      `core/test/fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field is the string `1.39.13`.
- [ ] A co-located unit test reads only that run-scoped path (no other pack
      run directory) and fails if `release_version` is missing or not
      `1.39.13`.
- [ ] Production files under `core/scripts/`, `hosts/`, and `plugin/` are
      unchanged.
- [ ] This change (`frg-13913-clean-openspec`) is the only active OpenSpec
      change for issue #1256. No foreign active change is introduced.
- [ ] Pre-merge archives this change into living specs. After archive, the
      PR contains `openspec/changes/archive/` and `openspec/specs/` paths
      and no non-archive `openspec/changes/<id>/` path for a foreign change.
- [ ] `npm run ci` is green. The fixture and test need no `plugin/`
      regeneration because `scripts/build.mjs` does not mirror `core/test/`.

## Capabilities

### New Capabilities

- `frg-13913-clean-openspec`: Run-scoped FRG `clean-openspec` fixture for pack
  run `pack-13913-release-v1.39.13-frg-20260827-1530`. The fixture at the
  run-scoped path SHALL name release `1.39.13`. A unit test SHALL verify that
  value. Production pipeline behavior SHALL NOT change.

### Modified Capabilities

<!-- None. Living `factory-reliability-gate` already requires the FRG pack.
     This change adds a synthetic pack-run fixture contract, not FRG driver
     law. -->

## Impact

- **New files (implementation, not this planning commit):**
  `core/test/fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json`
  and a co-located unit test under `core/test/`.
- **OpenSpec:** this change only. Pre-merge archives it into
  `openspec/specs/frg-13913-clean-openspec/spec.md`.
- **Not affected:** `core/scripts/` production code, hosts, plugin mirror,
  review/SHA-gate, merge commands, FRG driver scoring.
- **Class vs site:** this is a synthetic FRG path exercise, not an
  engine-recovery class defect. No classifier, recipe, gate, or controller
  change.
