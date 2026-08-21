## Context

See `proposal.md` for motivation. Issue #1207 is a synthetic FRG `clean-docs` item.
The template already names the fixture path and the expected `release_version`.
This design records the implementation shape so the apply step stays inside that
path.

## Goals / Non-Goals

**Goals:**

- Land one run-scoped JSON fixture and one hermetic unit test that pins
  `release_version` to `1.39.10`.
- Keep I/O in the test limited to reading that fixture file.

**Non-Goals:**

- No production edits under `core/scripts/`.
- No shared fixture used by other pack runs.
- No FRG driver, scoring, merge, or stage changes.
- No class-over-site recovery work: this item is a clean throughput fixture, not
  an engine-fault mole.

## Decisions

### 1. Exact pack-run directory, not a shared FRG fixture tree

Use
`core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json`.
The FRG template already requires that path. A shared `clean-docs.json` would
mix pack runs and would fail the "run-scoped path" acceptance rule.

Alternative considered: put the JSON next to the test file. Rejected because the
issue names the fixtures path.

### 2. Minimal JSON object

The fixture MUST include `release_version: "1.39.10"`. Other keys are optional
and unused by the pin test.

Alternative considered: copy the full FRG instance header (`pack_id`,
`pack_run_id`, hashes). Rejected as extra surface; the issue only requires the
version pin.

### 3. New co-located unit test file

Add `core/test/frg-clean-docs-pack-13910.test.ts` (or an equally pack-scoped
name). The test reads the fixture with `node:fs` and asserts
`release_version === "1.39.10"` with `node:assert/strict`. No network, git, or
subprocess.

Alternative considered: append to an existing FRG driver test. Rejected: those
files cover scoring and pack provenance, not this synthetic item.

### 4. No `plugin/` regeneration unless `core/` non-test production files change

A test-and-fixture-only change under `core/test/` does not require
`node scripts/build.mjs`. If implementation accidentally touches `core/scripts/`
or `hosts/claude`, regenerate the mirror in the same commit.

## Risks / Trade-offs

- [Living spec names one pack run] → Acceptable. This capability is the
  synthetic item's contract. Later packs add their own fixtures; they MUST NOT
  reuse this directory.
- [Test reads a committed file] → Keep the assertion exact (`1.39.10`) so a
  version edit fails without extra fixtures.
- [Temptation to "improve" production docs while here] → Out of scope. Do not
  edit `core/scripts/` or generated docs.

## Migration Plan

No migration. Add the fixture and test on this branch. Rollback is revert of
those two files.

## Open Questions

None.
