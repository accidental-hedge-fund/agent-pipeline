## Context

See proposal.md — Why. This is a synthetic FRG pack item
(`template_id=clean-openspec`, pack run `frg-1-33-0-f66627485c58a658c444ae3b`) whose
only product is a run-scoped fixture, one unit test, and an OpenSpec change that
pre-merge archives. Sibling template `clean-docs` already pins fixture field
`release_version`; this design reuses that shape so pack items stay consistent.

## Goals / Non-Goals

**Goals:**

- Pin the exact fixture path and JSON field the implementer must create.
- Keep the guarantee in a filesystem-backed unit test (no network/git/subprocess).
- Keep the OpenSpec surface minimal so pre-merge archive is mechanical.

**Non-Goals:**

- No production stage, CLI, config, or FRG runner changes.
- No shared fixture helper library; one small test is enough for this pack item.
- No reuse or extension of eval fixtures under `core/test/fixtures/` other than
  the new run-scoped FRG directory.

## Decisions

### Decision 1 — Field name `release_version`, value exactly `1.33.0`

**Choice:** The fixture JSON SHALL contain a top-level string field
`release_version` with value `1.33.0`.

**Why:** Matches `clean-docs` template wording and the pack manifest /
`pipeline-frg-instance` metadata key. Exact string equality (not semver range
parse) keeps the test trivial and the FRG proof deterministic.

**Alternatives considered:** `release` or nested `meta.release_version` — rejected
for pack-template consistency.

### Decision 2 — Run-scoped path isolation

**Choice:** Fixture lives only at

`core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json`

The unit test hard-codes or resolves that relative path under `core/test/fixtures/frg/`
and does not walk sibling pack-run directories.

**Why:** Acceptance requires the fixture and test use only the run-scoped path so
parallel FRG runs do not collide or share identity.

### Decision 3 — Minimal fixture body

**Choice:** Fixture is a small JSON object. Required: `release_version`. Optional
provenance keys (`pack_run_id`, `template_id`, `pack_id`) MAY be present for
human readability but the unit test MUST assert `release_version` only (required
guard); optional keys are not part of the normative requirement.

**Why:** The issue asks for one requirement and one verification; over-specifying
extra fields adds no FRG signal.

### Decision 4 — Test placement

**Choice:** One `node --test` file under `core/test/` (name up to implementer,
e.g. `frg-clean-openspec-1-33-0.test.ts` or a focused case in a small FRG fixture
test file). Read via `fs.readFileSync` + `JSON.parse` relative to the test file or
`core/` root — match existing fixture tests under `core/test/`.

**Why:** Co-located unit tests are the repo convention; no new harness.

### Decision 5 — No plugin mirror regeneration for test-only files

**Choice:** Do not run `node scripts/build.mjs` solely for `core/test/**` adds.
Only regenerate if an unexpected edit under mirrored `core/` production paths
appears (should not for this change).

**Why:** Mirror tracks production skill packaging, not unit-test fixtures.

## Risks / Trade-offs

- **[Risk] Living capability after archive** → Mitigation: the capability is
  intentionally tiny and pack-run-specific; after archive it documents a frozen
  FRG proof artifact. Future pack runs use a new `pack_run_id` path and a new
  change if they need a fresh synthetic item.
- **[Risk] Test path brittle if `core/test` layout moves** → Mitigation: use the
  same relative-path pattern as other `core/test/fixtures/**` tests; failure is
  immediate and local.
- **[Risk] Accidental production edits during implement** → Mitigation: tasks and
  proposal explicitly forbid `core/scripts/` changes; review checks the diff
  surface.

## Migration Plan

None. Additive test fixtures only. Rollback is delete the fixture, test, and
(if still active) the OpenSpec change directory.
