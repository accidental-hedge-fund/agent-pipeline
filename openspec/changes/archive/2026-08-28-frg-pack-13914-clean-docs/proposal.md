## Why

Issue #1279 is the Factory Reliability Gate (FRG) `clean-docs` instance for pack run
`pack-13914-pipeline-ship-1.39.14` (release `1.39.14`). The pack needs one clean
Pipeline path that adds a run-scoped documentation fixture and a unit test, then
reaches `pipeline:ready-to-deploy` without changing production behavior.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json`.
- Add a unit test that reads only that path and asserts `release_version` is
  `1.39.14`. The test SHALL fail if that value changes.
- Do not change production scripts, stages, prompts, CLI, or merge behavior.
- Do not add `auto_merge`, a merge stage, or merge inside advance/loop.

This is an FRG pack instance (`template_id=clean-docs`), not an engine-recovery
mole. Class is the run-scoped fixture-and-test contract. Site is this pack run
id. Shared classifier, recipe, gate, and controller law stay unchanged because
the issue forbids production-behavior change. The next pack run uses a new
`pack_run_id` directory; it does not need a new production mole.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field is exactly `1.39.14`.
- [ ] A unit test reads only that run-scoped path (no other pack-run directory)
      and fails when `release_version` is not `1.39.14`.
- [ ] No production module under `core/scripts/` changes behavior. The diff is
      the fixture, the test, this OpenSpec change, and (if needed) a generated
      `plugin/` mirror of test-only files.
- [ ] The unit test performs no real network, git, or subprocess calls.
- [ ] `npm run ci` is green.
- [ ] Advance/loop still stop at `pipeline:ready-to-deploy` and do not merge.

## Capabilities

### New Capabilities

- `frg-pack-13914-clean-docs`: Run-scoped FRG `clean-docs` fixture and unit test
  for pack `pack-13914-pipeline-ship-1.39.14` / release `1.39.14`.

### Modified Capabilities

<!-- None. Production FRG driver, ship coordinator, and recovery law do not change. -->

## Impact

- New files under `core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/` and
  `core/test/` (unit test only).
- OpenSpec change `frg-pack-13914-clean-docs`.
- Generated `plugin/` only if the test tree is mirrored; no production script
  edits.
- No GitHub API shape changes. No merge-path changes. No FRG driver changes.
