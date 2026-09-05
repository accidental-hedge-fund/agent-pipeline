## Why

Issue #1464 is the Factory Reliability Gate (FRG) `clean-docs` item for
release `1.40.1` and pack run `pack-1401-pipeline-ship-1.40.1`. The pack
must exercise one clean Pipeline path with a small documentation fixture and
its test. No production engine behavior changes.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- The fixture SHALL name release `1.40.1` in field `release_version`.
- Add a unit test that reads only that run-scoped path and fails when
  `release_version` is not `1.40.1`.
- Do not change production runtime, CLI, stages, config, or review policy.

**BREAKING:** none.

Non-goals: production behavior; other FRG templates (`clean-openspec`); other
pack runs; merge inside advance/loop; extra fixtures or tests outside the
run-scoped path; a shared FRG fixture loader; recreating `plugin/`.

## Acceptance criteria

- [ ] File
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field is the string `1.40.1`.
- [ ] A co-located unit test reads only that run-scoped path (no other pack
      run directory) and fails if `release_version` is missing or not
      `1.40.1`.
- [ ] Changing the fixture `release_version` to any other value makes that
      unit test fail.
- [ ] Production files under `core/scripts/` and `hosts/` are unchanged.
- [ ] The change does not recreate or commit `plugin/`.
- [ ] This change (`frg-pack-1401-clean-docs`) is the only active OpenSpec
      change for issue #1464. No foreign active change is introduced.
- [ ] The unit test performs no real network, git, or subprocess calls.
- [ ] `npm run ci` is green. The fixture and test need no host SKILL
      regeneration because `scripts/build.mjs` does not read `core/test/`.
- [ ] Advance/loop still stop at `pipeline:ready-to-deploy` and do not merge.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: Run-scoped FRG `clean-docs` fixture for pack
  run `pack-1401-pipeline-ship-1.40.1`. The fixture at the run-scoped path
  SHALL name release `1.40.1`. A unit test SHALL verify that value.
  Production pipeline behavior SHALL NOT change.

### Modified Capabilities

<!-- None. Living `factory-reliability-gate` already requires the FRG pack.
     This change adds a synthetic pack-run fixture contract, not FRG driver
     law. -->

## Impact

- **New files (implementation, not this planning commit):**
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
  and a co-located unit test under `core/test/`.
- **OpenSpec:** this change only. Pre-merge archives it into
  `openspec/specs/frg-pack-1401-clean-docs/spec.md`.
- **Not affected:** `core/scripts/` production code, hosts, host SKILL
  renderer, review/SHA-gate, merge commands, FRG driver scoring.
- **Reuse (first holding rung):** copy the pack-1400 / pack-13916 disk-read
  pattern (`node:fs` + `JSON.parse` + `node:assert/strict` from
  `import.meta.url`). Do not add a fixture loader, schema, or production
  import.
- **Class vs site:** this is a synthetic FRG path exercise, not an
  engine-recovery class defect. No classifier, recipe, gate, or controller
  change.
