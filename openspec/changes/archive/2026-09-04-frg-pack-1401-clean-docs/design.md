## Context

See `proposal.md` for why. Current tree:

- `core/test/fixtures/` has no `frg/` pack-run directory.
- Unit tests already read repo files with `node:fs` `readFileSync`, `JSON.parse`, and `node:test` `assert` (for example `core/test/version.test.ts`, `core/test/readme-landing-contract.test.ts`).
- Production engine code does not load `core/test/fixtures/`.

First holding rung after reading that code: reuse the existing test file-read pattern. Do not add a fixture loader, helper module, or production path.

## Goals / Non-Goals

**Goals:**

- One JSON file at the issue-named run-scoped path.
- One unit test that reads that file and asserts `release_version === "1.40.1"`.
- Keep production code, FRG templates, and merge authority untouched.

**Non-Goals:**

- A shared FRG fixture schema or loader.
- Changes to `factory-reliability-gate` scoring, pack templates, or auto-close.
- Classifier, recipe, gate, or controller work (this is not an engine-class fault).
- Host SKILL or docs-generator edits.

## Decisions

### 1. Reuse `node:test` + `node:fs`; do not add a loader

**Choice:** Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with at least `{ "release_version": "1.40.1" }`. Add a co-located unit test under `core/test/` that resolves that path from `import.meta.url`, `readFileSync`s it, `JSON.parse`s it, and `assert.equal`s `release_version` to `"1.40.1"`.

**Why:** That is the first holding rung already in this test tree. The issue names the path and the asserted field. A helper or production module would be a custom layer the implementer should not build.

**Alternatives considered:**

- Shared `loadFrgFixture(packRunId, templateId)` helper → extra API for one file; later packs can copy the same two-file pattern.
- Embed the version string only in the test, with no JSON file → misses the issue's fixture artifact.
- Teach production code to read the fixture → out of scope; the issue forbids production behavior change.

### 2. Fixture body is the asserted field, not a new schema

**Choice:** Require `release_version` as `"1.40.1"`. Extra identity fields (`pack_run_id`, `template_id`) are allowed and ignored by the assertion.

**Why:** The issue's falsifiable check is the version string. Do not invent a fixture contract beyond that field.

## Risks / Trade-offs

- [Living spec is pack-run-scoped] → Acceptable for this synthetic clean-path item. Archive keeps the fixture contract next to the files.
- [Later pack runs copy the same two files] → That is the intended reuse. Do not preempt them with a helper.

## Migration Plan

None. Additive test files only. Rollback is delete the fixture, test, and this OpenSpec change.
