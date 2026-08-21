## Context

See `proposal.md` for motivation. `core/test/fixtures/frg/` does not yet contain
a pack-run directory. Existing tests that load repo-local fixtures use
`readFileSync` plus `fileURLToPath(import.meta.url)` (example:
`core/test/stage-output-contract.test.ts`). Unit tests must not call real
network, git, or subprocess.

This instance is FRG template `clean-docs`, not `clean-openspec`. Production
scripts and the FRG driver stay unchanged.

## Goals / Non-Goals

**Goals:**

- Place one JSON fixture at the exact run-scoped path from the issue.
- Add one `node:test` file that reads that path and asserts `release_version`.
- Keep the test hermetic: in-process read of a repo-local file only.
- After the `core/test/` add, regenerate `plugin/` in the same change.

**Non-Goals:**

- No `core/scripts/` edits.
- No FRG template, manifest, or driver edits.
- No merge, auto-merge, or FRG close implementation.
- No shared fixture reused by later packs.

## Decisions

### Fixture is a small JSON object at the pack-run path

The issue names the path
`core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`.
The contract field is `release_version: "1.39.8"`. Extra identifying fields
(`pack_run_id`, `template_id`) MAY be present; the test MUST assert
`release_version` and MUST NOT require production parsers.

Alternative considered: encode the version only in the directory name. Rejected
because the issue requires a JSON field the test can fail on when it changes.

### One co-located unit test, not a production helper

A new file under `core/test/` (for example `frg-pack-1398-clean-docs.test.ts`)
reads the fixture and asserts the version. No new `core/scripts/` module.

Alternative considered: fold the assertion into `factory-reliability-gate.test.ts`.
Rejected: that file covers production FRG law. This instance must stay
run-scoped and easy to archive without touching FRG driver tests.

### Bite proof is a version mismatch

Implementation SHALL show the test fails when `release_version` is not
`1.39.8` (temporary fixture edit or equivalent assertion), then restore the
correct value so the suite is green.

### plugin/ mirror

A file under `core/test/` is a `core/` change. `node scripts/build.mjs` MUST
run in the same commit as the test and fixture.

## Risks / Trade-offs

- [Living spec names this pack run] → Acceptable. The capability is the
  instance contract. Later packs use a new path. Do not generalize into
  `factory-reliability-gate` production law.
- [Fixture read is filesystem I/O] → Allowed: the file is repo-local and
  the test does not spawn git, network, or subprocess.
- [plugin/ stale if forgotten] → Task list includes `build.mjs` after the
  `core/test/` add.

## Migration Plan

No rollout. Add fixture and test on this branch. No data migration. Rollback is
revert of the test and fixture files plus the regenerated `plugin/` mirror.
