## Context

See `proposal.md` for why.

`core/test/fixtures/` already holds JSON fixtures. Tests already load them with `node:fs` `readFileSync` and `JSON.parse` (`core/test/declared-dependency-grammar.test.ts`, `core/test/version.test.ts`). There is no `core/test/fixtures/frg/` directory yet and no clean-docs fixture helper.

This pack instance is test-only. Production modules under `core/scripts/` stay untouched.

## Goals / Non-Goals

**Goals:**

- Stop at the first holding reuse rung: existing `node:test` plus stdlib file read and JSON parse.
- Pin the fixture to the pack-run path `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- Keep the unit test hermetic: no network, git, or subprocess.

**Non-Goals:**

- A fixture loader, schema, or shared FRG fixture module.
- Production behavior, FRG pack generation, host SKILL, or merge.
- Fixtures for other pack-run ids.

## Decisions

### D1 — Stdlib read of a run-scoped JSON file

Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with at least `{ "release_version": "1.40.1" }`. Add a unit test under `core/test/` that resolves that relative path from the test file and asserts the field.

Reuse the existing pattern: `readFileSync` + `JSON.parse` + `assert.equal`. Do not add a helper, parser, or production import.

Alternative considered: a shared `loadFrgFixture(packRunId)` helper. Rejected: one fixture, one test; a helper is a custom layer the issue does not need.

Alternative considered: inline the JSON in the test. Rejected: the issue requires the run-scoped fixture path.

### D2 — Minimal fixture body

The test contract is `release_version === "1.40.1"`. The JSON object SHALL include that field. Extra identifying keys are optional and unused by the assertion.

Do not invent a fixture schema version or pack-manifest mirror.

### D3 — Test file naming

Name the test `core/test/frg-pack-1401-clean-docs.test.ts` to match existing `frg-*.test.ts` files. `cd core && npm test` already picks up `test/*.test.ts`.

## Risks / Trade-offs

- **[Risk]** A later pack copies the fixture into another directory and the test still reads the old path. → Mitigation: the test hard-pins `pack-1401-pipeline-ship-1.40.1/clean-docs.json`.
- **[Risk]** An implementer adds a production helper while adding the test. → Mitigation: tasks forbid edits under `core/scripts/`.
- **[Trade-off]** A one-off fixture is less reusable than a shared loader. Accepted: this instance is a factory-gate clean path, not a fixture framework.

## Migration Plan

No migration. Add the fixture and test. Rollback is delete those files.
