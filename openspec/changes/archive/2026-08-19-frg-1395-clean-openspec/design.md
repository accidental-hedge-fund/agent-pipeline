## Context

See `proposal.md` for motivation. This change is a synthetic FRG pack instance. It must exercise a clean OpenSpec propose → implement → archive path. Production stages stay unchanged.

`core/package.json` runs `node --test --experimental-strip-types test/*.test.ts`. The unit test must live as a top-level file under `core/test/`. The JSON fixture may live under the run-scoped directory named in the issue.

## Goals / Non-Goals

**Goals:**

- Keep the fixture path and the test path run-scoped to `pack-1395-tugboat-ship-1.39.5`.
- Make the release value a plain JSON field that a unit test can assert.
- Keep I/O inside the test as a local file read. No network, git, or subprocess.

**Non-Goals:**

- No production stage, CLI, or FRG driver change.
- No shared helper that other packs must import.
- No change to living `factory-reliability-gate` requirements.

## Decisions

1. **New capability, not a factory-reliability-gate delta.**
   The release string `1.39.5` is pack-run data. It is not standing FRG law.
   Archive still creates `openspec/specs/frg-1395-clean-openspec/spec.md`.
   FRG closes this pull request without merge, so main does not keep the spec.

2. **Fixture shape is a small JSON object.**
   Use `{ "release": "1.39.5" }` at `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json`.
   Alternative considered: reuse FRG evidence `version`. Rejected. This is not FRG evidence.

3. **One top-level unit test file.**
   Add `core/test/frg-1395-clean-openspec.test.ts`.
   It reads the run-scoped fixture with `node:fs` and asserts `release === "1.39.5"`.
   Alternative considered: nest the test next to the fixture. Rejected. The `test/*.test.ts` glob would miss it.

4. **No production import.**
   The test reads the fixture directly. Production scripts do not load this file.

## Risks / Trade-offs

- [Risk] A later implementer edits production code while adding the fixture. → Mitigation: tasks and the spec forbid production behavior change. Review the diff for `core/scripts/` edits.
- [Risk] `plugin/` becomes stale if `core/test/` is mirrored. → Mitigation: run `node scripts/build.mjs` after any `core/` edit and commit the mirror in the same change.

## Migration Plan

No migration. Add the fixture and test on this issue branch. Pre-merge archives this change. FRG records the run and closes the pull request without merge.
