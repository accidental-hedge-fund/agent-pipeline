## Context

See `proposal.md` for why. Current constraints:

- Factory-gate template `clean-docs` asks for a JSON fixture at
  `core/test/fixtures/frg/<pack_run_id>/clean-docs.json` and a unit test
  that checks `release_version`.
- Pack run id is `pack-13911-tugboat-ship-1.39.11`. Release is `1.39.11`.
- `core/test/fixtures/frg/` does not exist yet.
- `scripts/build.mjs` copies `core/scripts` and `core/profiles` into
  `plugin/`. It does not copy `core/test/`.
- Unit tests inject I/O via seams and do no real network, git, or
  subprocess calls. Reading a repo-local JSON fixture with `node:fs`
  is local file I/O, not those banned calls.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** This is a synthetic factory-gate pack instance, not
   an engine defect. Site is issue #1216. Class is the existing
   `clean-docs` template. No classifier, recipe, gate, or controller
   change is in scope.
2. **Shared surfaces.** None for production. The fixture lives under the
   pack-run directory named by the template.
3. **Next identical fault.** The next `clean-docs` pack instance uses the
   same template with a new `pack_run_id`. It does not need a mole issue.

## Goals / Non-Goals

**Goals:**

- Land one JSON fixture at the exact pack-run path.
- Land one unit test that fails if `release_version` is not `1.39.11`.
- Keep production code, plugin mirror, and merge law unchanged.

**Non-Goals:**

- Changing FRG scoring, close-without-merge, or pack templates.
- Adding merge authority or a merge stage.
- Regenerating `plugin/` (no `core/scripts/` or `hosts/claude` edit).
- A generic fixture loader for all future pack runs.

## Decisions

### 1. Hard-code the pack-run path in the test

**Choice:** The unit test reads
`core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json`
directly. It does not scan sibling pack-run directories.

**Why:** Acceptance requires the fixture and test to use only the
run-scoped path. A scanner would hide a misplaced fixture.

**Alternatives considered:**

- Shared helper over `core/test/fixtures/frg/*` — rejected; out of
  scope and would couple pack instances.
- Embed the JSON in the test file — rejected; the template requires a
  fixture file at that path.

### 2. Fixture JSON is a minimal object with `release_version`

**Choice:** The fixture is JSON with at least
`{ "release_version": "1.39.11" }`. Extra fields are allowed but not
required.

**Why:** The issue only requires that field. Extra schema would expand
scope.

**Alternatives considered:**

- Copy pack provenance (`pack_id`, `pack_run_id`, hashes) into the
  fixture — rejected; not required for this instance.

### 3. Co-located Node test; no production edit

**Choice:** Add a `core/test/*.test.ts` file that uses `node:test` and
`node:fs`. Do not edit `core/scripts/`.

**Why:** Production behavior must stay unchanged. Plugin rebuild is
unnecessary when `core/test/` is the only code surface.

**Alternatives considered:**

- Teach FRG driver to validate the fixture — rejected; that is a
  production change.

## Risks / Trade-offs

- **[Risk]** After archive, living specs keep a pack-run-specific
  capability. → **Mitigation:** Acceptable for a synthetic FRG
  instance. Pre-merge archive is the pipeline contract. Do not
  generalize the capability in this change.
- **[Risk]** A later pack run copies this fixture path by mistake.
  → **Mitigation:** The test pins the exact directory name
  `pack-13911-tugboat-ship-1.39.11`.

## Migration Plan

Additive test-only change. No deploy step. Rollback is revert of the
fixture and test files.
