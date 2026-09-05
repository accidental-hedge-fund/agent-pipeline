## Context

See `proposal.md` for why.

Existing patterns this change reuses:

- `core/test/declared-dependency-grammar.test.ts` reads a JSON fixture with `readFileSync` plus `JSON.parse` and asserts exact values. No fixture-loader helper exists.
- FRG pack templates already use field name `release_version` and run-scoped path `core/test/fixtures/frg/{{pack_run_id}}/`.
- Directory `core/test/fixtures/frg/` does not exist yet on this branch. Production scripts under `core/scripts/` do not read this fixture.

## Goals / Non-Goals

**Goals:**

- First holding rung: add one JSON file and one unit test that reuse `readFileSync` / `JSON.parse`.
- Keep the fixture and test on the run-scoped path only.
- Archive this OpenSpec change at pre-merge so no foreign active change remains.

**Non-Goals:**

- Production CLI, stage, merge, or FRG driver changes.
- A fixture loader, helper module, config key, or new test harness.
- Shared classifier / recipe / gate / controller work (this issue is a synthetic pack item, not engine recovery).
- A new public verb or merge-authority change.

## Decisions

### D1 — New pack-scoped capability, not a `factory-reliability-gate` delta

The living `factory-reliability-gate` spec describes the gate itself. This issue needs one requirement that the pack-1401-pipeline-ship-1.40.1 fixture names `1.40.1`. Put that in a new capability so the production FRG spec stays unpolluted.

Alternative considered: add the requirement to `factory-reliability-gate`. Rejected: that spec is not about this synthetic fixture.

### D2 — Field name `release_version`

Use `release_version` as the JSON key. Pack templates, observations, and FRG evidence already use that name.

Alternative considered: `version` or `release`. Rejected: it invents a second name for the same fact.

### D3 — Direct `readFileSync` in a `core/test/` unit test

The test SHALL join `import.meta.url` to `fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`, parse JSON, and assert `release_version === "1.40.1"`. Mirror `declared-dependency-grammar.test.ts`. Do not add a loader.

Alternative considered: a shared FRG fixture helper. Rejected: one file, one assertion.

### D4 — Fixture-only production isolation

Do not import the fixture from `core/scripts/`. Tests only.

## Risks / Trade-offs

- **[Risk]** A later pack run copies this fixture path and collides. → Mitigation: the path includes `pack_run_id` `pack-1401-pipeline-ship-1.40.1`.
- **[Risk]** Reviewers treat this as engine recovery and demand classifier work. → Mitigation: proposal and this design state it is a synthetic `clean-openspec` pack item.

## Migration Plan

No migration. Add the fixture and test on this branch. Pre-merge archives the change. Rollback is revert of the test files.
