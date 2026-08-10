## Context

See proposal.md for motivation. This item is a synthetic FRG pack path
(`template_id=clean-docs`) for release `1.33.0`. The repo already stores other
test fixtures under `core/test/fixtures/` and runs unit tests with
`node --test` from `core/`. No production stage or FRG driver change is in
scope.

## Goals / Non-Goals

**Goals:**

- Land one run-scoped JSON fixture and one unit test that pin
  `release_version` to `1.33.0`.
- Keep the fixture path exclusive to pack run
  `frg-1-33-0-d5d716355f2ed48d04aa8dde`.
- Keep the diff small enough that the full Pipeline can reach
  `pipeline:ready-to-deploy` without production risk.

**Non-Goals:**

- Changing FRG driver, pack templates, scoreboard, or auto-close behavior.
- Sharing fixtures across pack runs.
- Regenerating `plugin/` (no `core/scripts/` or host skill edits).
- Documenting operator runbooks beyond what already exists for FRG packs.

## Decisions

1. **Run-scoped directory under `core/test/fixtures/frg/<pack_run_id>/`**
   - Rationale: Matches the FRG clean-docs template path and isolates this run
     from other pack runs and future releases.
   - Alternative considered: a shared `core/test/fixtures/frg/clean-docs.json`
     — rejected because it collides across concurrent or successive FRG runs.

2. **Minimal JSON shape with at least `release_version`**
   - Rationale: The acceptance criterion only requires verifying
     `release_version === "1.33.0"`. Extra fields are optional and not required
     by the template.
   - Alternative considered: a rich schema (pack_id, template_id, etc.) —
     deferred; not needed for the pin assertion.

3. **Co-located unit test under `core/test/`**
   - Rationale: Repo convention is `core/test/*.test.ts` with
     `node --test --experimental-strip-types`. Read the fixture with
     `fs.readFileSync` / `JSON.parse` relative to the test file or repo-known
     path under `fixtures/frg/...`.
   - Alternative considered: embedding the expected version only in the test
     without a fixture file — rejected because the pack template requires both
     fixture and test.

4. **No production code changes**
   - Rationale: Issue scope is explicitly a clean docs path exercise.
   - Alternative considered: wiring the fixture into FRG observation code —
     out of scope and would expand risk.

## Risks / Trade-offs

- **[Risk] Fixture path typo vs pack_run_id** → Mitigation: copy the exact id
  `frg-1-33-0-d5d716355f2ed48d04aa8dde` from the issue provenance block into
  both the directory name and any path strings in the test.
- **[Risk] Test passes against a wrong shared fixture** → Mitigation: hard-code
  only the run-scoped relative path; do not fall back to alternate paths.
- **[Trade-off] One-off fixture per FRG run** increases fixture tree growth over
  time; acceptable for synthetic pack items and keeps runs isolated.

## Migration Plan

Not applicable. Additive test-only change. Rollback is delete the fixture
directory and the new test file.
