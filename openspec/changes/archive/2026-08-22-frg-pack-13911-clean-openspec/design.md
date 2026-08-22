## Context

See `proposal.md` for why. Issue #1217 is the FRG `clean-openspec` template
instance for pack `pack-13911-tugboat-ship-1.39.11` / release `1.39.11`.
The sibling `clean-docs` template already names a JSON `release_version`
field. `scripts/build.mjs` copies `core/scripts` and `core/profiles` into
`plugin/`, not `core/test/`.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** This issue is a synthetic FRG pack instance
   (`template_id=clean-openspec`), not an engine recover or ship-path
   fault. The class is the pack template: one OpenSpec-bearing clean path
   with a run-scoped fixture and a version-asserting test. The site is
   pack run `pack-13911-tugboat-ship-1.39.11` on issue #1217.
2. **Shared surfaces.** No classifier, recipe, gate, or controller change.
   Production FRG driver and pipeline stages stay unchanged.
3. **Next identical instance.** The next pack run instantiates the same
   template with a new `pack_run_id` and release. This change is that
   instance, not a mole for a production defect.

## Goals / Non-Goals

**Goals:**

- One JSON fixture at the pack-run path with `release_version: "1.39.11"`.
- One unit test that reads that file and asserts the field.
- One OpenSpec capability that states the same contract.

**Non-Goals:**

- Production script, CLI, stage, prompt, or merge changes.
- Regenerating `plugin/` (tests are not in the mirror set).
- Editing living `factory-reliability-gate` driver law.
- Merging the PR (FRG closes without merge after it records the run).

## Decisions

### 1. New capability instead of a factory-reliability-gate delta

**Choice:** Add `frg-pack-13911-clean-openspec` as a new capability.

**Why:** The requirement is pack-run specific (`1.39.11` /
`pack-13911-tugboat-ship-1.39.11`). Putting that string into living FRG
driver law would pollute a shared spec. A new capability stays scoped to
this instance and archives cleanly.

**Alternative considered:** Modify `factory-reliability-gate`. Rejected.
That spec governs the driver and pack inventory, not one pack-run fixture.

### 2. Fixture field is `release_version`

**Choice:** The JSON object SHALL use `release_version` with value
`1.39.11`.

**Why:** The sibling `clean-docs` template already verifies
`release_version`. Same field name keeps pack fixtures uniform.

**Alternative considered:** A free-form `release` string or nested
provenance object. Rejected. The issue asks for one named release value.

### 3. Test reads the fixture from disk; no production import

**Choice:** A `core/test/*.test.ts` file reads the run-scoped JSON with
`node:fs` and asserts `release_version === "1.39.11"`. It SHALL NOT import
production stage modules to make that assertion.

**Why:** The issue forbids production behavior change. A file read is
enough to make the test bite when the version string changes.

**Alternative considered:** Teach the FRG driver to load this fixture.
Rejected. That would be a production change.

### 4. No plugin mirror for this implementation

**Choice:** Implementation SHALL NOT run `node scripts/build.mjs` unless
a later edit touches `core/scripts/` or `core/profiles/`.

**Why:** `CORE_ENTRIES` in `scripts/build.mjs` is `scripts`, `profiles`,
`package.json`, `package-lock.json`. Fixture and test files under
`core/test/` are not mirrored.

## Risks / Trade-offs

- **Foreign active OpenSpec change.** A leftover change from another issue
  would fail pack archive hygiene. → This change is the only active
  change for #1217. Pre-merge archives it.
- **Accidental production edit.** A later implementer might "help" by
  wiring the fixture into the FRG driver. → Tasks forbid `core/scripts/`
  edits. Spec says production behavior SHALL NOT change.
- **Living-spec clutter on a merged branch.** Archiving a pack-run
  capability would land `1.39.11` in living specs if this PR merged.
  → FRG closes the PR without merge after it records the run.

## Migration Plan

No production migration. Add fixture and test on this branch. Pre-merge
archives the OpenSpec change. FRG records the run and closes the PR and
issue without merge.

## Open Questions

None.
