## Context

See `proposal.md` for why. This item is the FRG `clean-openspec`
template for pack run `pack-1398-tugboat-ship-1.39.8` (issue #1195).
The sibling `clean-docs` template already names the JSON field
`release_version`. `core/test/fixtures/frg/` does not exist yet.
Tests inject I/O via fakes; this fixture is a static JSON file, so the
test reads the file from disk and does not call production code.

FRG live observation later requires the PR to contain an archived
OpenSpec change, a living spec under `openspec/specs/`, and no active
change path.

## Goals / Non-Goals

**Goals:**

- Land one run-scoped JSON fixture and one unit test that binds it to
  release `1.39.8`.
- Keep the OpenSpec change unique to this synthetic issue.
- Archive at pre-merge so the living spec path exists.

**Non-Goals:**

- Changing production engine, CLI, stages, prompts, or FRG pack
  templates.
- Reusing or modifying `factory-reliability-gate` living requirements.
- Sharing a fixture path with another pack run.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Add `frg-pack-1398-clean-openspec` as a new capability.
Do not add a pack-run-specific fixture rule to the living
`factory-reliability-gate` spec.

**Why:** The requirement names one pack run and one release. Putting it
on the shared FRG spec would mix synthetic pack data into product law.
A new capability stays unique to this issue and still archives into
`openspec/specs/` as FRG requires.

**Alternatives considered:**

- Delta on `factory-reliability-gate` → rejected; living FRG law would
  then require a `1.39.8` fixture forever.
- `skip_specs: true` → rejected; the issue requires one OpenSpec
  requirement and an archive path.

### 2. Field name `release_version`

**Choice:** The fixture JSON SHALL use `release_version` with value
`"1.39.8"`.

**Why:** The sibling FRG `clean-docs` template verifies that same field
name. Tests and operators then share one term.

**Alternatives considered:**

- `version` or `release` → rejected; those names collide with package
  version and git tags, and they diverge from `clean-docs`.

### 3. Unit test reads the file; it does not import production code

**Choice:** A co-located test under `core/test/` reads the run-scoped
path with `fs` and asserts `release_version === "1.39.8"`. It does not
call `core/scripts/` modules.

**Why:** Production behavior must not change. A file assertion is the
smallest check that fails if the fixture is missing, moved, or renamed
to another pack directory.

**Alternatives considered:**

- Import an FRG loader → rejected; that would touch production
  surfaces or imply new production behavior.
- Inline the expected string without reading the fixture → rejected;
  that would not prove the run-scoped file exists.

### 4. Plugin mirror after the `core/` test and fixture land

**Choice:** After adding files under `core/`, run `node scripts/build.mjs`
and commit the regenerated `plugin/` in the same implementation change.

**Why:** CI fails `build.mjs --check` when the mirror is stale.

## Risks / Trade-offs

- **[Risk] A later pack run copies this fixture path.** → Mitigation:
  the path includes `pack-1398-tugboat-ship-1.39.8`. The test binds that
  exact directory.
- **[Risk] Living spec remains after archive for one synthetic pack.** →
  Trade-off accepted. FRG requires an archived spec file. Do not fold
  it into shared FRG law.
- **[Risk] `core/` test files must be mirrored.** → Mitigation: regenerate
  `plugin/` in the same implementation commit.

## Migration Plan

1. Implement the fixture and unit test on this branch. Do not change
   production modules.
2. Pre-merge archives `frg-pack-1398-clean-openspec`.
3. Rollback: revert the fixture, test, spec, and mirror. No runtime
   state to unwind.

## Open Questions

None.
