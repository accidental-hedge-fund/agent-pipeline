## Context

See `proposal.md` for why. Constraints that shape the approach:

- Issue #1425 is a synthetic factory-gate-v1 `clean-openspec` item. The
  pack run id is `pack-1401-pipeline-ship-1.40.1`. The release is `1.40.1`.
- The sibling `clean-docs` template already names the JSON field
  `release_version`.
- First holding reuse rung on this tree: `core/test/version.test.ts` reads
  a repo JSON file with `node:test`, `node:fs` `readFileSync`,
  `JSON.parse`, and `node:assert/strict`. Commit `44a6e679`
  (`core/test/frg-pack-1400-clean-openspec.test.ts`) is the same class for
  the prior pack. Copy that two-file pattern. Do not add a fixture loader.
- `scripts/build.mjs` regenerates host SKILLs from renderer sources under
  `core/scripts/`. A `core/test/`-only change does not require that
  regeneration. Do not recreate `plugin/` (#1050).
- Pre-merge already archives the active OpenSpec change. This design does
  not add archive logic.

This is site-scoped by the pack template. Shared FRG classifier, recipe,
gate, and controller law stay unchanged.

## Goals / Non-Goals

**Goals:**

- One run-scoped JSON fixture and one unit test that proves
  `release_version` is `1.40.1`.
- Stop at the first holding reuse rung: existing test stack and the sibling
  field name.
- Keep this OpenSpec change as the only active change for issue #1425.

**Non-Goals:**

- Production CLI, stage, config, host, or FRG-driver edits.
- A fixture loader, helper module, or registry.
- A delta to `factory-reliability-gate` living spec.
- A second OpenSpec change.
- Recreating `plugin/`.

## Decisions

### D1 — JSON field is `release_version`

The sibling `clean-docs` template already requires `release_version`. Use
that key. Do not invent `release`, `version`, or a nested schema.

Alternative considered: a generic `{ "release": "1.40.1" }` object.
Rejected: it splits the two FRG templates on the same pack.

### D2 — Test reads the file with stdlib only

Add a small unit test under `core/test/` that resolves
`fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` from the
test file URL, reads UTF-8, parses JSON, and asserts
`release_version === "1.40.1"`. Reuse `node:test` / `node:assert/strict` /
`node:fs` / `node:url`. Do not add a helper.

Alternative considered: fold the assertion into
`frg-pack-observations.test.ts`. Rejected: that file scores pack collector
evidence; this is fixture content.

### D3 — New capability, not a factory-reliability-gate delta

The living FRG spec is driver and gate law. A one-pack fixture pin does not
change that law. Archive lands
`openspec/specs/pack-1401-clean-openspec/spec.md`, which satisfies the
clean-openspec pack check that the PR contains `openspec/specs/` files.

Alternative considered: add the pin to `factory-reliability-gate`.
Rejected: it would bake a run-scoped `1.40.1` requirement into production
FRG law.

### D4 — No production modules

The fixture and test are the whole implementation. Do not edit
`core/scripts/`. If a later `core/` edit happens, `node scripts/build.mjs`
still runs; this change does not require that edit.

## Risks / Trade-offs

- [Living spec keeps a pack-run pin] → Accept. The template asks for a
  requirement that names `1.40.1`. Pre-merge archive is the pack pass
  condition.
- [Sibling `clean-docs` issue may land a parallel fixture tree] → Keep this
  change on `clean-openspec.json` only. Do not share a fixture file.
- [A wrapped second-line SHALL fails planning validation] → Keep `SHALL` on
  the first body line after each `### Requirement:` header.

## Migration Plan

1. Planning commit: this OpenSpec change only.
2. Implementation commit: fixture + unit test under `core/test/`.
3. Pre-merge archives `pack-1401-clean-openspec` into living specs. No
   rollback beyond reverting those commits.
