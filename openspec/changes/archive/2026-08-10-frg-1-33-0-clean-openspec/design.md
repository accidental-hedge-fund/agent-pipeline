## Context

See proposal.md for motivation. This change is a synthetic FRG `clean-openspec` pack item for
release `1.33.0` / pack run `frg-1-33-0-d5d716355f2ed48d04aa8dde`. The repo already has FRG pack
templates under `core/scripts/frg-packs/factory-gate-v1/` and co-located unit tests under
`core/test/`. There is no existing `core/test/fixtures/frg/<pack_run_id>/` tree for this run;
implementation creates only that path plus a hermetic unit test.

Constraints:

- OpenSpec change must be sole active change for this issue (no foreign active changes at pre-merge).
- Fixture and test must use the run-scoped path only (no shared cross-run fixture).
- No production behavior changes.
- Tests inject no network/git/subprocess; a JSON read + assert is enough.

## Goals / Non-Goals

**Goals:**

- Choose a minimal fixture JSON shape and path layout that the unit test can assert against.
- Keep the OpenSpec requirement falsifiable from the fixture file alone.
- Stay within test-only surface so `plugin/` mirror regeneration is unnecessary.

**Non-Goals:**

- FRG driver, scoreboard, or pack-template code changes.
- Shared fixtures reusable across pack runs.
- Production config or CLI flags.
- Merging the synthetic PR (FRG closes without merge after scoring).

## Decisions

### 1. Run-scoped fixture path is the pack_run_id directory

**Choice:** Place the fixture at
`core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-openspec.json`.

**Why:** Matches the issue body and keeps this pack run isolated from other FRG instances that
may land later under `core/test/fixtures/frg/<other-pack_run_id>/`.

**Alternatives considered:**

- Flat file named with pack_run_id → harder to group multi-file pack fixtures later.
- Shared `clean-openspec.json` under a version-only path → collides when multiple runs target the
  same release.

### 2. Fixture field for release version is `release_version`

**Choice:** JSON object includes at least `"release_version": "1.33.0"`. Optional companion fields
(`pack_run_id`, `template_id`) may be present for readability but are not required by the
OpenSpec requirement beyond the release version assertion.

**Why:** Aligns with FRG evidence / pack rendering field names (`release_version` in
`frg-pack-observations` and factory-gate evidence). One stable key keeps the unit test trivial.

**Alternatives considered:**

- Nested `meta.release` → unnecessary nesting for a synthetic one-field contract.
- Filename-only encoding of the version → not machine-readable for a JSON fixture test.

### 3. Unit test is file-local and hermetic

**Choice:** A single `core/test/*.test.ts` (e.g. `frg-1-33-0-clean-openspec-fixture.test.ts`) that
resolves the fixture via `import.meta.url` / `fileURLToPath` relative to the repo layout, reads
JSON with `fs`, and asserts `release_version === "1.33.0"`. No deps injection needed.

**Why:** Matches existing co-located Node test style; proves the requirement without touching
production seams.

**Alternatives considered:**

- Piggyback on `frg-pack-observations.test.ts` → mixes synthetic pack-run data into general pack
  tests and risks path coupling across runs.

### 4. New capability instead of modifying `factory-reliability-gate`

**Choice:** New capability `frg-clean-openspec-run-fixture`.

**Why:** The living FRG driver spec describes production gate behavior. This item is a disposable
synthetic contract for one pack instance; a separate capability keeps archive/merge noise out of
the production FRG requirements.

**Alternatives considered:**

- ADDED requirement on `factory-reliability-gate` → permanently couples a one-off fixture path
  into the gate capability.

## Risks / Trade-offs

- **[Risk] Living-spec residue if the PR ever merges** → Mitigation: FRG auto-closes without
  merge; if a human merges later, the archived capability is still a harmless test-contract spec.
- **[Risk] Fixture path typo breaks isolation** → Mitigation: tasks and test hard-code the full
  pack_run_id segment from the issue body.
- **[Trade-off] Capability name is FRG-fixture-specific** → Acceptable for a synthetic path
  exercise; avoids inventing product behavior.

## Migration Plan

Not applicable for production. Implementation order: fixture → unit test → `npm test` / `npm run
ci` → pre-merge OpenSpec archive (pipeline stage). Rollback is delete the fixture, test, and
(if needed) re-open the change; no data migration.
