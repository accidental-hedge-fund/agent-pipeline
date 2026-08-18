## Context

See `proposal.md` for why. Issue #1113 is the `clean-openspec` item in
FRG pack `pack-1392-tugboat-ship-1.39.2` (release `1.39.2`). The pack
template requires a run-scoped fixture, one OpenSpec requirement that
names that release, and a unit test. Production behavior stays
unchanged.

**Class vs site:** the site is this pack-run path. The class is a
synthetic clean-openspec pack instance: fixture + OpenSpec
propose/archive + unit test, no production change. Shared
classifier, recipe, gate, and controller code stay unchanged. The
next pack uses a new `pack_run_id` path. It does not need a
production mole.

## Goals / Non-Goals

**Goals:**

- Land a static JSON fixture at the pack-run path.
- Bind `release_version` to `1.39.2` in that file.
- Add one `node:test` unit test that reads only that path.
- Keep this change as the only active OpenSpec change for #1113.

**Non-Goals:**

- Production stage, CLI, label, merge, or FRG scoring changes.
- A generic fixture loader or shared FRG helper.
- Editing `factory-reliability-gate` living requirements.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Add `frg-clean-openspec-fixture`. Do not add this
pack-run constant to `factory-reliability-gate`.

**Why:** The living FRG spec is production gate law. A run-scoped
fixture version is not a scoring or release rule. Archive still
creates a living spec for the fixture contract.

**Alternative:** Delta `factory-reliability-gate`. Rejected. That
would mix a synthetic pack instance into release-gate law.

### 2. Static JSON plus a direct file read

**Choice:** Write
`core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
with `release_version: "1.39.2"`. Add
`core/test/frg-pack-1392-clean-openspec.test.ts`. The test reads the
file with `node:fs` and asserts the field.

**Why:** The issue asks for a fixture and a unit test only. Existing
tests already read files with `node:fs`. No production import is
needed.

**Alternative:** Import a production helper that validates pack
fixtures. Rejected. That would change production behavior.

### 3. Mirror only if `core/` files land

**Choice:** After the fixture and test exist under `core/`, run
`node scripts/build.mjs` and commit the generated `plugin/` mirror
in the same implementation commit.

**Why:** `plugin/` is a generated mirror. A `core/`-only commit
fails `build.mjs --check`.

## Risks / Trade-offs

- **[Risk]** A later pack archives another fixture spec and the
  living `frg-clean-openspec-fixture` spec grows one-off paths.
  → Mitigation: keep this requirement scoped to this pack-run path.
  Later packs add their own run-scoped requirement or change.

- **[Risk]** An extra active OpenSpec change from another issue
  would fail the FRG "no foreign active change" check.
  → Mitigation: create only this change. Do not author a second
  change for #1113.

## Migration Plan

No production migration. Implementation adds fixture + test.
Pre-merge archives this change. Rollback is revert of those files.

## Open Questions

None.
