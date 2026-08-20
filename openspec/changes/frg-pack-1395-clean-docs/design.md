## Context

See `proposal.md` for motivation. This is a one-file fixture plus one unit
test. `core/test/fixtures/frg/` does not exist yet. `scripts/build.mjs`
copies `core/scripts`, `core/profiles`, and `core/package*.json` only.

## Goals / Non-Goals

**Goals:**

- Pin the fixture to the exact pack-run path from issue #1157.
- Make the version assertion fail if `release_version` drifts.
- Keep the test in `core/test/` so `npm test` / `npm run ci` pick it up.

**Non-Goals:**

- Shared fixture helpers or a reusable FRG fixture loader.
- Plugin regeneration.
- Production or FRG-driver edits.

## Decisions

### Decision: Dedicated pack-run directory, not a shared FRG fixture file

Use
`core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
A shared file under `core/test/fixtures/frg/clean-docs.json` would mix pack
runs.

**Alternative considered:** reuse a prior pack-run fixture. Rejected. The
issue requires the run-scoped path only.

### Decision: Test reads the JSON file from disk

The test parses the committed fixture with `node:fs` and `node:path` from
`core/test/`. It asserts `release_version === "1.39.5"`. A later implementer
MAY add a second assertion that mutates a copy in memory to prove the bite;
the committed fixture stays `1.39.5`.

**Alternative considered:** hard-code the expected JSON in the test and skip
the file. Rejected. The issue requires a fixture file and a test that reads
it.

### Decision: No plugin rebuild

Test-only files under `core/test/` are not part of `CORE_ENTRIES` in
`scripts/build.mjs`. Do not run `node scripts/build.mjs` unless a later
edit touches a copied `core/` entry.

## Risks / Trade-offs

- **[Risk]** A later pack instance copies this fixture path by habit. →
  Mitigation: the path includes `pack-1395-tugboat-ship-1.39.5`. Specs
  forbid sibling pack-run directories for this change.
- **[Risk]** Reviewers treat this as engine-dogfood recover and ask for a
  class fix. → Mitigation: the proposal states this is a synthetic
  `clean-docs` pack instance, not a recover class.

## Migration Plan

No migration. Add the fixture and test on the issue branch. FRG closes the
pull request without merge after it records the run.

## Open Questions

None.
