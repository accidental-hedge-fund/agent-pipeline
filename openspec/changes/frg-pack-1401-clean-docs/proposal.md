## Why

Factory Reliability Gate (FRG) pack `pack-1401-pipeline-ship-1.40.1` needs one clean Pipeline path for release `1.40.1`. Issue #1436 is the `clean-docs` pack instance: a small run-scoped JSON fixture plus a unit test that pins `release_version` to `1.40.1`. Production engine behavior does not change.

## What Changes

- Add a run-scoped JSON fixture at `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- Add a unit test that reads that exact path and asserts `release_version` is `1.40.1`.
- Do not change production CLI, stages, prompts, host SKILL, merge, or FRG driver behavior.
- Do not invent a fixture loader, schema, or helper. Reuse the existing `core/test/*.test.ts` plus `node:fs` `readFileSync` / `JSON.parse` pattern.

## Acceptance criteria

- [ ] File `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` exists and parses as JSON.
- [ ] That fixture’s `release_version` field is the string `1.40.1`.
- [ ] A unit test under `core/test/` reads that exact run-scoped path (not a shared or other-pack fixture path) and asserts `release_version === "1.40.1"`.
- [ ] Changing the fixture `release_version` to any other string makes that unit test fail.
- [ ] The test performs no real network, git, or subprocess calls.
- [ ] Production code under `core/scripts/` is unchanged.
- [ ] `npm test` in `core/` (or `npm run ci` from the repo root) is green with the new test.

## Capabilities

### New Capabilities

- `frg-pack-1401-clean-docs`: Run-scoped FRG `clean-docs` fixture and unit test for pack run `pack-1401-pipeline-ship-1.40.1` that pin `release_version` to `1.40.1` without production behavior change.

### Modified Capabilities

- None. Living `factory-reliability-gate` law is unchanged. This is one pack-instance clean path, not a gate, classifier, recipe, or controller change.

## Impact

- New files only: the run-scoped JSON fixture and one `core/test/*.test.ts`.
- No production modules, no host SKILL regeneration, no `plugin/`, no merge surface, no FRG pack template edit.
- After `core/` test-file edits, `node scripts/build.mjs` is not required unless `core/scripts/` or host SKILL sources change (they will not).
- FRG still closes the pull request and issue without merge after it records the run. That close behavior is existing pack-driver law, not this change.

### Engine-dogfood bar (#1436)

This issue is a factory-gate `clean-docs` pack instance, not an engine defect.

1. **Class vs site.** Class: none. Site: synthetic pack item #1436 for `pack-1401-pipeline-ship-1.40.1`.
2. **Shared law.** No classifier, recipe, gate, or controller change. The shared `clean-docs` template already names this fixture path.
3. **Next identical fault.** The next pack run uses a new `pack_run_id` and a new issue. That is pack isolation, not a mole.
