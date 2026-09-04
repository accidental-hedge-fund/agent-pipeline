## Context

See `proposal.md` for why.

`core/test/fixtures/` has no `frg/` directory today. Existing unit tests already load JSON with Node `readFileSync` plus `JSON.parse` and assert with `node:test` (`core/test/declared-dependency-grammar.test.ts`). Factory-gate pack templates live under `core/scripts/frg-packs/factory-gate-v1/`. This change is the `clean-docs` instance for pack run `pack-1401-pipeline-ship-1.40.1`, not a change to that engine.

## Goals / Non-Goals

**Goals:**

- First holding rung: add one JSON file and one `node:test` file. Reuse `node:fs` and `node:test`. Do not add a fixture loader, helper module, CLI verb, or production path.
- Pin `release_version` to `1.40.1` at the run-scoped path the pack template names.

**Non-Goals:**

- Changing Factory Reliability Gate scoring, templates, auto-close, or merge.
- A shared FRG fixture framework for later pack runs.
- The sibling `clean-openspec` pack item.

## Decisions

### D1 — Stdlib test, no new layer

Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with `release_version` `"1.40.1"`. Add `core/test/frg-pack-1401-clean-docs.test.ts` that resolves that path with `fileURLToPath` / `dirname` / `join`, reads it with `readFileSync`, parses JSON, and asserts `release_version === "1.40.1"`.

Alternative considered: a reusable FRG fixture helper. Rejected: one file, one assertion, YAGNI.

Alternative considered: a Markdown docs file under `docs/`. Rejected: the pack template names this JSON path.

### D2 — Fixture fields stay minimal

Require only `release_version`. Extra identity fields are allowed. They are not required.

Alternative considered: copy the full FRG instance header into JSON. Rejected: the test only pins the release version.

## Risks / Trade-offs

- [Risk] A later pack run copies this fixture path. → Mitigation: the path includes `pack-1401-pipeline-ship-1.40.1`. The test reads only that path.
- [Risk] Review treats this as an engine-class recover and asks for classifier/recipe changes. → Mitigation: this is a pack instance. Keep production code unchanged.

## Migration Plan

No migration. The fixture and test are additive. Rollback is delete those two files.
