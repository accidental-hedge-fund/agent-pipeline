## Context

See `proposal.md` for motivation and `specs/frg-pack-1401-clean-docs/spec.md` for normative behavior.

`core/test/` already hosts `node:test` files. Nearby tests already read files with `node:fs` and parse JSON with `JSON.parse`. `core/test/fixtures/` already holds static fixtures. There is no `core/test/fixtures/frg/` directory yet; this pack run creates one subdirectory named for `pack_run_id`.

The first holding rung is reuse of that existing test and fixture layout. No loader, helper, production module, or dependency is required.

## Goals / Non-Goals

**Goals:**

- Place one JSON fixture at the exact run-scoped path from issue #1456.
- Add one unit test that reads that path and pins `release_version` to `1.40.1`.
- Keep the test bite: a changed version fails.

**Non-Goals:**

- Production CLI, stage, FRG driver, merge, or host-skill changes.
- A shared FRG fixture helper or schema validator.
- Fixtures for other pack runs or the `clean-openspec` template.

## Decisions

### D1 — Static JSON fixture plus a direct `node:test` read

Write `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with at least `{ "release_version": "1.40.1" }`. Add a unit test under `core/test/` that resolves that path from the test file, reads the file, parses JSON, and asserts equality on `release_version`.

Use `node:fs`, `node:path`, `node:url` (`fileURLToPath` / `import.meta.url`), `node:test`, and `node:assert/strict` as neighboring tests already do.

Alternative considered: a reusable fixture loader under `core/scripts/`. Rejected because this pack item must not change production behavior and YAGNI forbids a one-use helper.

Alternative considered: embed the JSON inline in the test. Rejected because the issue requires the run-scoped fixture path as the contract location.

### D2 — Keep the test hermetic and path-exact

The test reads the committed fixture from disk. That is the same pattern other `core/test/` files use for static files. It does not call `gh`, git, or a subprocess. The asserted path is the pack-run path only.

## Risks / Trade-offs

- [Risk] A later pack run copies this fixture into a shared helper. → Mitigation: this change does not introduce a helper; later packs keep their own run-scoped path.
- [Risk] The fixture JSON grows extra unused fields. → Mitigation: the contract requires `release_version`; extra fields are allowed but unused.
- [Risk] Pre-merge archives this synthetic capability into living specs on the PR branch. → Mitigation: FRG closes the PR without merge; main living specs stay unchanged.

## Migration Plan

No migration. Add the fixture and test. No rollback surface beyond reverting the PR branch.
