## Context

See `proposal.md` for motivation. Issue #1169 is the FRG `clean-docs` instance for pack run
`pack-1396-tugboat-ship-1.39.6`. The implementation is a JSON fixture plus one unit test.
No production module is in scope.

Constraints:

- Fixture path is fixed: `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json`.
- The test MUST bind to that path and MUST fail when `release_version` is not `1.39.6`.
- Unit tests use `node --test` under `core/test/` and inject network/git/subprocess I/O. A
  local fixture read is allowed; this repo already reads on-disk fixtures in unit tests.
- Edit `core/`, never `plugin/` by hand. This change does not touch `core/scripts/`, so the
  generated mirror stays unchanged.

## Goals / Non-Goals

**Goals:**

- Place a minimal JSON fixture at the run-scoped path.
- Add one hermetic unit test that reads that file and asserts `release_version === "1.39.6"`.
- Keep the diff limited to test fixtures and the new test file.

**Non-Goals:**

- Production behavior, CLI, stage, review, or FRG-driver changes.
- A shared fixture used by later pack runs.
- Merge, auto-merge, or merge-queue work.
- Classifier / recipe / recovery-controller changes (this is a synthetic pack instance, not
  an engine-recovery mole).

## Decisions

### 1. Fixture shape is a small JSON object keyed by `release_version`

- **Choice:** `{ "release_version": "1.39.6" }`. Optional extra fields (`pack_run_id`,
  `template_id`) are allowed if they help humans read the file, but the test SHALL only
  require `release_version`.
- **Why:** The issue names one field and one value. Extra schema would invent product
  contract.
- **Alternative:** YAML or Markdown — rejected; the issue requires JSON.

### 2. One dedicated unit test file under `core/test/`

- **Choice:** a new `core/test/*.test.ts` that `readFileSync`s the run-scoped path, parses
  JSON, and asserts `release_version`.
- **Why:** Co-located `node --test` is the repo test layout. Binding the path in the test
  makes a version change fail without a fake deps seam.
- **Alternative:** embed the version only in the test with no fixture file — rejected; the
  issue requires the fixture path.
- **Alternative:** a shared `core/test/fixtures/frg/clean-docs.json` — rejected; the issue
  requires the pack-run directory.

### 3. No `plugin/` regeneration

- **Choice:** do not run `node scripts/build.mjs` unless an unexpected `core/` production
  edit appears.
- **Why:** Golden rule 1 applies after `core/` source edits. Fixture and test files are not
  mirrored into `plugin/`.

## Risks / Trade-offs

- [Archive on the PR branch writes a living spec that main never receives] → Accept. FRG
  closes this PR without merge after it records the run. That is existing pack disposition.
- [A later pack run copies this fixture path] → Mitigation: the test and spec name the
  pack-run directory. The next pack instance uses its own `pack_run_id` path from the
  template.

## Migration Plan

None. This is synthetic pack work. Rollback is unused because FRG does not merge the PR.
