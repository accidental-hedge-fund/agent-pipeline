## Context

See `proposal.md` for why.

`core/test/fixtures/frg/` has no pack-run directories today. The factory-gate
`clean-openspec` template names the path
`core/test/fixtures/frg/{{pack_run_id}}/clean-openspec.json`. The sibling
`clean-docs` template names the field `release_version`. Existing unit tests
already load JSON with `fs.readFileSync` and `JSON.parse` (`core/test/version.test.ts`).

This change is pack-scoped synthetic work. It is not a factory-reliability-gate
scoring change.

## Goals / Non-Goals

**Goals:**

- First holding rung after reading in-scope tests: a static JSON file plus a
  `node:test` assertion that uses stdlib `fs` / `JSON.parse`.
- Keep the fixture and test on
  `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`.
- Keep production modules under `core/scripts/` unchanged.

**Non-Goals:**

- A fixture loader, schema registry, or shared FRG helper.
- A new CLI verb or production behavior.
- A delta against `factory-reliability-gate` or other living scoring law.
- Other pack-run fixtures.

## Decisions

### D1 — New pack-scoped capability, not a factory-reliability-gate delta

Add `frg-pack-1401-clean-openspec` as a new capability. Do not add a
`1.40.1`-specific requirement to `factory-reliability-gate`.

That living spec is release-scoring law. This issue is one synthetic pack
instance. A new capability keeps the one required SHALL on this fixture.

Alternative considered: modify `factory-reliability-gate`. Rejected: that would
bind a pack-run constant into production scoring requirements.

### D2 — Static JSON at the template path; field `release_version`

Write one JSON object at the template path. Set `release_version` to `1.40.1`.
The sibling `clean-docs` template already names that field. Reuse it.

The file MAY also record `pack_run_id` and `template_id` for readability. Those
fields are not the normative requirement.

Do not add a TypeScript loader or schema. The unit test reads the file.

Alternative considered: a shared fixture helper under `core/scripts/` or
`core/test/`. Rejected: stdlib already holds this rung.

### D3 — Hermetic unit test with node:test

Add one test file under `core/test/` that:

1. Resolves the run-scoped path relative to the test file.
2. Parses JSON with `JSON.parse`.
3. Asserts `release_version === "1.40.1"`.

Inject no network, git, or subprocess. Do not call production pipeline code.

Prove the test bites: a wrong `release_version` must fail the assertion.

Alternative considered: extend `factory-reliability-gate.test.ts`. Rejected: that
suite scores packs. This issue only checks the fixture value.

## Risks / Trade-offs

- [Archive writes a pack-scoped living spec] → Accept. This issue exists to
  exercise OpenSpec author → implement → archive. Factory Reliability Gate
  closes the pull request without merge, so `main` does not keep the spec.
- [A later pack run copies this layout] → That is the template contract. Each
  run uses its own `pack_run_id` directory. Do not share fixture files across
  runs.
