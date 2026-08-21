## Context

See `proposal.md` for motivation. Issue #1188 is the `clean-docs` template instance for FRG pack `pack-1398-tugboat-ship-1.39.8`. `core/test/fixtures/frg/` does not exist yet. Existing unit tests under `core/test/` read JSON with `node:test` plus `node:fs` and inject no network, git, or subprocess.

This is synthetic pack-instance work, not engine-class recover. Class-over-site FRG driver changes are out of scope.

## Goals / Non-Goals

**Goals:**

- Land one JSON fixture at the run-scoped path named by the issue.
- Land one unit test that pins `release_version` to `1.39.8` from that path only.

**Non-Goals:**

- Production script, stage, prompt, or FRG driver edits.
- Shared fixture helpers for later packs.
- Plugin mirror regeneration.
- Merge, auto-merge, or FRG close-without-merge machinery (the gate owns that after ready-to-deploy).

## Decisions

1. **Hard-code the pack-run path.** The issue names `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json`. The test reads that path. It does not glob sibling packs. Alternative: a shared loader keyed by `pack_run_id`. Rejected because this item must stay run-scoped and production-inert.

2. **Fixture is JSON with `release_version`.** The issue requires JSON and a version pin. Extra fields MAY exist; the test only asserts `release_version`. Alternative: a markdown docs file. Rejected because the issue names a JSON fixture.

3. **Co-located `node:test` file under `core/test/`.** Match `readme-landing-contract.test.ts` and other hermetic tests: `fs.readFileSync` + `JSON.parse` + `assert.equal`. No `deps` seam is needed because there is no production I/O.

4. **No `plugin/` rebuild.** Tests and fixtures live under `core/test/`, which the generated skill mirror does not include.

## Risks / Trade-offs

- [Archive adds a living one-off spec] → Accept. This repo plans through OpenSpec. Pre-merge archives the change on the branch. FRG then closes the PR without merge, so main does not keep the instance spec.
- [A sibling clean-openspec pack item also authors an OpenSpec change] → Keep this change id unique (`frg-pack-1398-clean-docs`) and do not share the fixture path with `clean-openspec.json`.
- [A later pack copies the wrong directory] → The test hard-fails unless this exact path and version match.

## Migration Plan

Add the fixture and test on this branch. No production deploy step. Rollback is delete of those two files plus this OpenSpec change.
