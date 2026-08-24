## Context

See `proposal.md` for why. Constraints that shape the approach:

- Issue #1231 is the FRG `factory-gate-v1` template `clean-openspec` item for
  pack `pack-13912-tugboat-ship-1.39.12` / release `1.39.12`.
- The work is a fixture, one OpenSpec requirement, and a unit test. It must
  not change production behavior.
- The sibling `clean-docs` template names the JSON field `release_version`.
- Pre-merge archives this change. FRG live observation requires archived
  OpenSpec files under `openspec/changes/archive/` and `openspec/specs/`,
  with no leftover active change path on the PR.
- Tests inject no real network, git, or subprocess. A file read of a
  committed fixture is allowed.

This is a synthetic FRG pack item, not engine-dogfood recovery. Class-vs-site
does not apply: there is no classifier, recipe, gate, or controller defect.

## Goals / Non-Goals

**Goals:**

- Pin the fixture path and `release_version` value in a new capability so
  archive leaves a living spec.
- Keep implementation to one JSON file and one unit test.

**Non-Goals:**

- Edits to `factory-reliability-gate` production requirements.
- A shared fixture loader or production reader for FRG pack fixtures.
- `plugin/` regeneration (no `core/` script change).
- Merge, auto-close, or FRG driver behavior.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

- **Choice:** Add `frg-pack-13912-clean-openspec`.
- **Why:** The requirement is pack-run-scoped. Putting it on
  `factory-reliability-gate` would mix synthetic fixture law into release
  gate law.
- **Alternative:** Modify `factory-reliability-gate`. Rejected: that
  capability is production FRG precondition law.

### 2. Field name is `release_version`

- **Choice:** The fixture object uses `release_version: "1.39.12"`.
- **Why:** The sibling `clean-docs` template verifies `release_version`.
  Same field name keeps pack items consistent.
- **Alternative:** A field named `release`. Rejected: it would diverge from
  the sibling template.

### 3. Minimal JSON object

- **Choice:** The fixture is JSON with at least
  `{ "release_version": "1.39.12" }`. Extra fields are allowed.
- **Why:** The issue only requires that the fixture name the release.
- **Alternative:** A full FRG evidence bundle. Rejected: out of scope and
  would look like production evidence.

### 4. Unit test reads the file directly

- **Choice:** A `core/test/*.test.ts` file reads the run-scoped path with
  `node:fs` / `JSON.parse` and asserts `release_version === "1.39.12"`.
- **Why:** No production module should grow a fixture loader for this pack
  run. Direct read keeps production scripts untouched.
- **Alternative:** Import a new `core/scripts/` helper. Rejected: that
  would change production surface.

### 5. One active change

- **Choice:** This directory is the only active OpenSpec change for #1231.
- **Why:** FRG `clean-openspec` observation fails if a foreign active
  change remains on the PR after archive.
- **Alternative:** Reuse or extend an existing active change. None exists
  on this branch.

## Risks / Trade-offs

- **[Risk]** The living spec after archive is pack-run-specific. → Accept.
  That archive path is the FRG exercise. Do not fold it into production
  FRG law.
- **[Risk]** Implement leaves the change active. → Pre-merge archive is
  the existing pipeline step. Tasks do not skip it.
- **[Risk]** A later edit retargets the test at a different pack path. →
  The spec names the exact path; the test must use that path only.

## Migration Plan

- Land fixture + test on this issue's PR.
- Pre-merge archives `frg-pack-13912-clean-openspec` into
  `openspec/specs/frg-pack-13912-clean-openspec/spec.md`.
- Rollback is revert of the PR. No runtime migration.
