## Context

See `proposal.md` for motivation. This is one fixture file plus one unit
test file. `core/test/fixtures/frg/` does not exist yet. `scripts/build.mjs`
`CORE_ENTRIES` copies `core/scripts`, `core/profiles`, and
`core/package*.json` only.

## Goals / Non-Goals

**Goals:**

- Pin the fixture to the exact pack-run path from issue #1143.
- Make the version assertion fail if `release_version` is missing or drifts.
- Keep the test in `core/test/frg-pack-1395-clean-docs.test.ts` so
  `npm test` / `npm run ci` pick it up.

**Non-Goals:**

- Shared fixture helpers or a reusable FRG fixture loader.
- Fixture globbing, shared-pack lookup, or fallback paths.
- Plugin regeneration.
- Production or FRG-driver edits.
- Implementing FRG close-without-merge. That is pipeline lifecycle
  verification after the run is recorded.

## Decisions

### Decision: Dedicated pack-run directory, not a shared FRG fixture file

Use
`core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
A shared file under `core/test/fixtures/frg/clean-docs.json` would mix pack
runs.

**Alternative considered:** reuse a prior pack-run fixture. Rejected. The
issue requires the run-scoped path only.

### Decision: Named test file reads one exact path

Add only `core/test/frg-pack-1395-clean-docs.test.ts`. Resolve the fixture
with `dirname(fileURLToPath(import.meta.url))` plus
`join(..., "fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json")`.
Do not glob `fixtures/frg/**`. Do not look up another pack-run directory.
Do not fall back to a second path.

This matches `core/test/declared-dependency-grammar.test.ts`, which reads
one named JSON file with `readFileSync` + `JSON.parse` and then asserts on
the parsed object.

### Decision: Strict equality on the parsed field

The test reads the file, parses JSON, then asserts
`release_version === "1.39.5"` via `assert.equal` from
`node:assert/strict`. Missing `release_version` and a changed value such
as `1.39.4` both fail that same assertion. Prove the bite on a temporary
wrong or missing value, then restore `1.39.5` before commit.

**Alternative considered:** hard-code the expected JSON in the test and skip
the file. Rejected. The issue requires a fixture file and a test that reads
it.

### Decision: OpenSpec metadata is permitted; production is not

The fixture and `core/test/frg-pack-1395-clean-docs.test.ts` are the only
functional test-content additions. Required OpenSpec change files under
`openspec/changes/frg-pack-1395-clean-docs/` remain permitted. Do not
edit `core/scripts/`, `hosts/`, or `plugin/`.

### Decision: No plugin rebuild

Test-only files under `core/test/` are not part of `CORE_ENTRIES` in
`scripts/build.mjs`. Do not run `node scripts/build.mjs` unless a later
edit touches a copied `core/` entry.

### Decision: Tester evidence is a gate, not a claim

Do not claim a suite pass until `cd core && npm test` and `npm run ci`
exit 0 on the committed SHA, and the engine test-gate records current
SHA-pinned tester evidence. Missing tester evidence is not a pass.

## Risks / Trade-offs

- **[Risk]** A later pack instance copies this fixture path by habit. →
  Mitigation: the path includes `pack-1395-tugboat-ship-1.39.5`. Specs
  forbid sibling pack-run directories for this change.
- **[Risk]** Reviewers treat this as engine-dogfood recover and ask for a
  class fix. → Mitigation: the proposal states this is a synthetic
  `clean-docs` pack instance, not a recover class.
- **[Risk]** An implementer claims green tests before tester evidence
  exists. → Mitigation: treat SHA-pinned tester evidence as required
  verification, not optional commentary.

## Migration Plan

No migration. Add the fixture and named test on the issue branch. FRG
close-without-merge stays outside implementation scope.

## Open Questions

None.
