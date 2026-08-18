## Context

See `proposal.md` for why.

`core/test/fixtures/frg/` does not exist yet. FRG template `clean-docs.md`
names one run-scoped JSON file and a unit test that binds `release_version`.
No production module consumes that file.

**Class vs site:** the site is issue #1112 / pack run
`pack-1392-tugboat-ship-1.39.2`. The class is an FRG `clean-docs` pack item:
a fixture under `core/test/fixtures/frg/<pack_run_id>/` plus a unit test that
fails if `release_version` drifts. This is not a ship-path recover fault.
No shared classifier, recipe, gate, or controller change is in scope. The
next pack uses a new `pack_run_id` and the same path pattern. It does not
need a production mole.

## Goals / Non-Goals

**Goals:**

- Add the exact fixture path the template names.
- Bind `release_version` with one `node:test` unit test.
- Keep the diff limited to the fixture and that test.

**Non-Goals:**

- Production stage, CLI, config, or prompt edits.
- A shared fixture loader or FRG scoring change.
- Close-without-merge (existing FRG driver).
- Reuse of another pack run's fixture directory.

## Decisions

### 1. Fixture is a static JSON file at the template path

**Choice:** Write
`core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`
with at least `{ "release_version": "1.39.2" }`. Extra metadata keys are
allowed if they stay unused by production code.

**Why not** generate the file at test time: the acceptance criterion is a
checked-in run-scoped path.

**Why not** put the file under `docs/`: the template and issue name
`core/test/fixtures/frg/<pack_run_id>/`.

### 2. One co-located unit test reads only that path

**Choice:** Add one file under `core/test/` (for example
`frg-pack-1392-clean-docs.test.ts`). The test reads the fixture with
`node:fs` + `JSON.parse` (or `import` of the JSON) and asserts
`release_version === "1.39.2"`.

**Why not** extend `factory-reliability-gate.test.ts`: that file covers
scoring and evidence. This item is a pack fixture, not FRG driver
behavior.

**Why not** a parameterized suite over all `fixtures/frg/*`: this issue
owns only `pack-1392-tugboat-ship-1.39.2`.

### 3. No production code and no new test helper

**Choice:** Do not add a loader under `core/scripts/`. Do not change
stages, CLI, or prompts. `scripts/build.mjs` copies `core/scripts`,
`core/profiles`, and the core package files. It does not copy
`core/test/`. A fixture-and-test-only change does not need a `plugin/`
regeneration.

## Risks / Trade-offs

- [Living spec names one pack run] → Accept. Archive keeps the instance
  contract. The next FRG pack files its own item with a new `pack_run_id`.
- [Fixture field set is underspecified beyond `release_version`] → Specify
  only `release_version`. Extra keys must not create production readers.
- [Someone later adds a production reader] → Out of scope. The item
  stays fixture + test only.

## Migration Plan

- Add fixture + test on this issue branch.
- No rollout flag. No rollback beyond revert of those files.

## Open Questions

None.
