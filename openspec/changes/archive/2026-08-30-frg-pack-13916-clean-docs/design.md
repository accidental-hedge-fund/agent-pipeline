## Context

See `proposal.md` for why. Constraints that shape the approach:

- Issue #1334 is a synthetic FRG `clean-docs` item. The pack run id is
  `pack-13916-pipeline-ship-1.39.16`. The release is `1.39.16`.
- `core/test/fixtures/frg/` does not exist on the issue base. The
  implementation creates that tree.
- Existing tests load committed JSON from `import.meta.url` via
  `path.dirname(fileURLToPath(import.meta.url))` plus `fs.readFileSync` and
  `JSON.parse` (see `core/test/js-yaml-advisory-floor.test.ts` and
  `core/test/readme-landing-contract.test.ts`). Commit `aafabd73` used the
  same pattern for pack-13915 `clean-openspec`.
- `scripts/build.mjs` mirrors `CORE_ENTRIES`: `scripts`, `profiles`,
  `package.json`, and `package-lock.json`. A `core/test/`-only change does not
  require a `plugin/` regeneration.
- Pre-merge already archives the active OpenSpec change. This design does
  not add archive logic.

**Reuse ladder (first holding rung):** this is already in the codebase.
Copy the disk-read `node:test` pattern. Use stdlib `node:fs`, `JSON.parse`,
and `node:assert/strict`. Do not invent a fixture loader, schema, helper
module, or production import.

## Goals / Non-Goals

**Goals:**

- Land one JSON fixture at the run-scoped path with `release_version` set to
  `1.39.16`.
- Land one co-located unit test that reads that file and fails on a wrong or
  missing `release_version`.
- Keep the OpenSpec change isolated to this issue so pre-merge can archive it
  without a foreign active change.

**Non-Goals:**

- Production engine, CLI, stage, config, host, or plugin edits.
- A shared FRG fixture loader or schema used by later pack runs.
- Changing living `factory-reliability-gate` driver law.
- Merge, review-policy, or SHA-gate behavior.

## Decisions

### 1. New capability, not a factory-reliability-gate delta

**Choice:** Add `frg-pack-13916-clean-docs` as a new capability. Do not
modify `openspec/specs/factory-reliability-gate/spec.md`.

**Why:** The living FRG spec describes the gate driver and pack inventory.
This issue's contract is a synthetic pack-run fixture that names `1.39.16`.
Mixing that into FRG driver law would couple a one-run artifact to
release-precondition rules.

**Alternatives considered:**

- Delta on `factory-reliability-gate` → rejected. Wrong layer.
- `skip_specs: true` → rejected. The fixture contract is spec-level
  behavior for this pack run.

### 2. Fixture shape is a small JSON object with `release_version`

**Choice:** The fixture is JSON:

```json
{
  "release_version": "1.39.16"
}
```

Optional extra keys are allowed. The required key is `release_version` as
the string `1.39.16`. The unit test asserts that key only.

**Why:** The sibling FRG template `clean-openspec` names the same field.
The issue requires the fixture to name release `1.39.16`, not a full pack
manifest.

**Alternatives considered:**

- Reuse `factory-gate-v1` manifest schema → rejected. Over-specified for
  this synthetic path.
- Hard-code the version only in the test with no fixture file → rejected.
  The issue requires the run-scoped JSON path.

### 3. Test reads the fixture from disk; no production import

**Choice:** Add `core/test/frg-pack-13916-clean-docs.test.ts`. The test joins
`core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-docs.json`
from `import.meta.url`, `JSON.parse`s the file, and asserts
`release_version === "1.39.16"`. It does not import `core/scripts/`.

**Why:** First holding rung after reading in-scope tests. A disk-read
assertion is the smallest test that bites a wrong version. No `deps` seam
is needed because there is no network, git, or subprocess.

**Alternatives considered:**

- Assert inside `factory-reliability-gate.test.ts` → rejected. That file
  covers driver law; this is a pack-run fixture.
- Import production FRG modules to validate the fixture → rejected. Would
  couple a synthetic file to driver internals.
- Assert against `core/package.json` `version` → rejected. A later version
  bump would retarget this pack instance.

### 4. No plugin regeneration

**Choice:** Implementation edits `core/test/` only. Do not run
`node scripts/build.mjs` unless a later review forces a `core/scripts/`
edit (that edit is out of scope).

**Why:** `CORE_ENTRIES` in `scripts/build.mjs` does not include `test/`.

## Risks / Trade-offs

- **[Risk] Living specs keep a pack-run-specific capability after archive.**
  → Acceptable. FRG `clean-docs` observes archived specs under
  `openspec/specs/`. A one-run capability is the intended archive payload.
- **[Risk] A later pack run copies this fixture path and drifts the
  version.** → Mitigation: the unit test is bound to this pack-run path and
  fails if `release_version` changes.
- **[Trade-off] No shared fixture schema.** → Acceptable. A shared loader
  would be a custom layer the reuse ladder forbids.

## Migration Plan

1. Planning commit: this OpenSpec change only.
2. Implementation commit: fixture + unit test under `core/test/`.
3. Pre-merge archives `frg-pack-13916-clean-docs` into living specs. No
   rollback beyond reverting those commits.
