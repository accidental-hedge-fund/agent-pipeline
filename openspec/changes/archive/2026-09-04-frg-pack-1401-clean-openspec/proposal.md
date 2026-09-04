## Why

Issue #1437 is the factory-gate `clean-openspec` pack item for
`pack-1401-pipeline-ship-1.40.1`. The pack needs one clean Pipeline path that
authors an OpenSpec change, implements a run-scoped fixture plus a unit test,
and later archives that change. No production CLI, stage, or merge behavior
changes.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- The fixture SHALL set `release_version` to `1.40.1`.
- Add a unit test that reads only that path and asserts `release_version` is
  `1.40.1`.
- Author one OpenSpec requirement for that fixture contract. Pre-merge archives
  this change. The PR then has archived change files and living spec files, and
  no foreign active change path.
- Do not change production behavior.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-openspec`: run-scoped factory-gate fixture for pack
  `pack-1401-pipeline-ship-1.40.1`. The fixture at
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
  names release `1.40.1`, and a unit test verifies that value.

### Modified Capabilities

- (none)

## Impact

- **Scope:** test fixture and unit test only. No production modules, CLI verbs,
  stages, labels, merge authority, or host SKILL behavior.
- **Reuse first:** existing `core/test/` pattern: `readFileSync` from `node:fs`,
  `JSON.parse`, `node:test` plus `node:assert/strict`. Do not add a fixture
  loader, helper module, config key, or production API.
- **Class vs site:** this issue is a synthetic factory-gate pack item
  (`template_id=clean-openspec`), not an engine recover or ship-path fault. No
  classifier, recipe, gate, or controller change is in scope.
- **OpenSpec:** this change is the only active change for #1437. Pre-merge
  archives it. The implementer does not leave a second active change.
- **Tests:** hermetic unit test. No network, git, or subprocess.
- **Out of scope:** production behavior; other pack-run fixture paths;
  `clean-docs`; merge; auto-merge; a second durable scheduler.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.40.1`.
- [ ] A unit test under `core/test/` reads only that run-scoped path and fails when `release_version` is not `1.40.1`.
- [ ] The test does not read any other `core/test/fixtures/frg/` pack-run directory.
- [ ] No production source under `core/scripts/` changes.
- [ ] This change `frg-pack-1401-clean-openspec` is the only active OpenSpec change for issue #1437.
- [ ] Pre-merge archives this change into `openspec/specs/frg-pack-1401-clean-openspec/` and leaves no foreign active change under `openspec/changes/` (other than `archive/`).
