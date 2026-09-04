## Context

See `proposal.md` for why. See `specs/frg-pack-1401-clean-docs/spec.md` for behavior.

In-scope today:

- `core/test/*.test.ts` already uses `node:test`, `node:assert/strict`, and
  `node:fs` `readFileSync` against repo files (`readme-landing-contract.test.ts`,
  `scoped-factory-policy-docs.test.ts`).
- `core/test/fixtures/` already holds test-only files. There is no
  `core/test/fixtures/frg/` directory yet.
- `core/scripts/frg-packs/factory-gate-v1/templates/clean-docs.md` already names
  the run-scoped path
  `core/test/fixtures/frg/{{pack_run_id}}/clean-docs.json`.
- `npm test` in `core/` already globs `test/*.test.ts`. A new test file is
  picked up without a harness or registry change.

This is a factory-gate pack instance, not an engine defect. Do not add
classifier, recipe, gate, or controller law.

## Goals / Non-Goals

**Goals:**

- Pin `release_version` `1.40.1` at the run-scoped fixture path.
- Make a unit test fail if that value changes.
- Stay on the first holding reuse rung: existing test file + stdlib JSON read.

**Non-Goals:**

- Production CLI, stage, prompt, FRG driver, or merge changes.
- A fixture loader, JSON schema, shared FRG fixture helper, or new test
  harness.
- Editing `templates/clean-docs.md` or `manifest.json`.
- Host SKILL regeneration or `plugin/` work.

## Decisions

### D1 — First holding rung: new test file plus stdlib read

**Choice:** Add `core/test/frg-pack-1401-clean-docs.test.ts`. Resolve the fixture
with `fileURLToPath(import.meta.url)` and `path.join` to
`fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. Read with
`fs.readFileSync`, parse with `JSON.parse`, assert
`release_version === "1.40.1"` using `node:assert/strict`.

**Why:** That is the pattern already used by `readme-landing-contract.test.ts`.
The issue names the path. `npm test` already discovers `test/*.test.ts`.

**Alternatives considered:**

- Shared `loadFrgPackFixture()` in `core/scripts/` — extra production surface
  for a test-only file. Rejected.
- Import JSON via a bundler / `with { type: "json" }` — Node type-stripping
  tests already use `readFileSync`. Rejected as a new pattern.
- Put the assertion inside `factory-reliability-gate.test.ts` — mixes gate
  driver tests with a pack-instance fixture. Rejected.

### D2 — Minimal fixture object

**Choice:** The fixture JSON SHALL contain at least
`{ "release_version": "1.40.1" }`. Extra keys are not required.

**Why:** The issue only names `release_version`. Extra pack metadata would be
scope-broadening.

**Alternatives considered:**

- Mirror the full `pipeline-frg-instance@1` HTML comment as JSON keys —
  unused by the test. Rejected.

### D3 — No production diff

**Choice:** Do not edit `core/scripts/`, host SKILL sources, or FRG pack
templates. After implementation, `git diff -- core/scripts hosts` SHALL be
empty.

**Why:** The issue says do not change production behavior. Host SKILL check
(`node scripts/build.mjs --check`) stays green without a rebuild because
`core/scripts/` is untouched.

## Risks / Trade-offs

- **[Risk]** A later pack run copies this fixture path and collides. →
  **Mitigation:** The path includes `pack-1401-pipeline-ship-1.40.1`. Tests for
  other runs MUST use their own `pack_run_id` directory.
- **[Risk]** Reading the real fixture file looks like I/O in a unit test. →
  **Mitigation:** Repo convention forbids real network, git, and subprocess in
  unit tests, not local fixture reads. Do not spawn `node --test` as a child
  to prove the fail-on-version-change scenario inside the committed test;
  the committed test asserts the live value. The fail-on-change contract is
  the assertion itself.
- **[Risk]** Living spec after archive describes one pack instance. →
  **Mitigation:** Acceptable. The requirement is path-scoped. Do not generalize
  it into FRG driver law.

## Migration Plan

- Add the two files. No deploy or data migration.
- Rollback: delete the fixture and the test file.
