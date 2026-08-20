## Context

See `proposal.md` for why. Issue #1177 is a synthetic Factory Reliability
Gate (FRG) pack item (`template_id=clean-openspec`,
`pack_run_id=pack-1397-tugboat-ship-1.39.7`). It is not an engine-dogfood
recovery or ship-path fault. Class-over-site does not apply. The class
this item exercises is the existing OpenSpec author → implement → archive
path.

`core/test/fixtures/frg/` does not exist yet. Tests already load
repo-local files with `node:fs` (see `readme-landing-contract.test.ts`).
That pattern needs no `deps` seam because it does not call network, git,
or subprocesses.

## Goals / Non-Goals

**Goals:**

- One JSON fixture at the pack-run path named in the issue.
- One co-located unit test that asserts `release_version === "1.39.7"`.
- Keep this the only active OpenSpec change for #1177.

**Non-Goals:**

- Production pipeline, Factory Reliability Gate (FRG) driver, pack
  template, or scoring changes.
- A shared fixture loader or a general FRG fixture schema.
- Extra pack-run directories for other templates or versions.

## Decisions

### 1. JSON field is `release_version`

**Choice:** The fixture uses `release_version` with value `1.39.7`.

**Why:** Pack metadata and templates already use `release_version` (see
`core/scripts/frg-packs/factory-gate-v1/templates/clean-openspec.md` and
`manifest.json`). A second key named `release` would invent a synonym.

**Alternative considered:** A free-form `release` string. Rejected. The
repo already has one name for this value.

### 2. Fixture path is pack-run scoped, not shared

**Choice:** Write
`core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json`.
The unit test hard-codes that relative path from `core/test/`.

**Why:** The issue requires a run-scoped path. A shared
`fixtures/frg/clean-openspec.json` would collide with later packs.

**Alternative considered:** Embed the JSON in the test file. Rejected.
The pack template names an on-disk fixture path.

### 3. Test is file-read only; no production import

**Choice:** Add `core/test/frg-pack-1397-clean-openspec.test.ts`. It reads
the fixture with `fs.readFileSync` / `JSON.parse` and asserts the field.
It does not import production modules.

**Why:** Production behavior must not change. Importing engine code would
invite a production edit. A file-read test matches existing repo-local
contract tests.

**Alternative considered:** Hook the assertion into
`factory-reliability-gate.test.ts`. Rejected. That file tests the FRG
driver. Mixing a synthetic pack fixture into it would look like a
production contract.

### 4. Minimal fixture body

**Choice:** Required field is `release_version`. Optional identifying
keys (`pack_run_id`, `template_id`) may be present. The spec does not
require them.

**Why:** The issue asks for one named release. Extra required keys would
expand the OpenSpec contract past the pack item.

## Risks / Trade-offs

- [Archive leaves a version-specific living spec] → Accept. This pack
  item exists to exercise OpenSpec archive. The living spec is the
  archive product, not a new engine law.
- [Later packs copy the same path] → The directory is pack-run scoped.
  A later pack uses its own `pack_run_id` directory.
- [A reviewer asks for a production class fix] → This issue is a
  synthetic clean path. Do not edit FRG driver or pipeline stages.

## Migration Plan

No production migration. Pre-merge archives
`frg-pack-1397-clean-openspec` into
`openspec/specs/frg-pack-1397-clean-openspec/spec.md`. Rollback is revert
of the fixture, test, and archived spec.
