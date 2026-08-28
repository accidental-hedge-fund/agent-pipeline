## Context

See `proposal.md` for motivation. `core/test/fixtures/frg/` does not exist yet.
`scripts/build.mjs` mirrors `core/scripts`, `core/profiles`, and
`core/package.json` into `plugin/`. It does not mirror `core/test/`. Adding a
fixture and a test therefore does not require a plugin regeneration unless a
production file under the mirrored entries also changes.

Unit tests in this repo inject I/O via `deps` for GitHub, harness, and
worktree seams. Reading a committed fixture with `node:fs` is the existing
pattern for file-backed contract tests (`readme-landing-contract.test.ts`).
That read is not a network, git, or subprocess call.

## Goals / Non-Goals

**Goals:**

- One JSON fixture at the exact pack-run path.
- One unit test that parses that file and asserts `release_version === "1.39.14"`.
- Keep production `core/scripts/` unchanged.

**Non-Goals:**

- FRG driver, pack template, ship coordinator, or recovery-controller edits.
- Shared classifier / recipe / gate / controller law (this is an FRG instance,
  not an engine-class recovery).
- Merge inside advance/loop, `auto_merge`, or `--skip-frg`.
- Reuse of a sibling pack-run fixture directory.

## Decisions

### 1. Run-scoped directory, not a shared FRG fixture

**Choice:** Put the file at
`core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json`.

**Why:** The `clean-docs` template names that path. A shared
`core/test/fixtures/frg/clean-docs.json` would mix pack runs and fail the
run-scoped acceptance rule.

**Alternatives considered:**

- Shared fixture without `pack_run_id` in the path → rejected: violates the
  issue path.
- Fixture under `openspec/` or `docs/` → rejected: the issue names
  `core/test/fixtures/frg/`.

### 2. Committed JSON plus a node:test reader

**Choice:** Minimal JSON object with `release_version: "1.39.14"`. A new
`core/test/*.test.ts` file reads that path with `fs.readFileSync` +
`JSON.parse` and `assert.equal`.

**Why:** The test must fail when the version string changes. Hard-coding the
expected version in the test (not reading `package.json`) keeps the fixture
pin independent of the engine version field.

**Alternatives considered:**

- Assert against `core/package.json` `version` → rejected: a later version
  bump would fail this pack instance or silently retarget it.
- Inject a fake `readFile` seam → unnecessary: this is a committed fixture,
  not an external I/O boundary.

### 3. No production diff, no plugin mirror unless scripts change

**Choice:** Do not edit `core/scripts/`. Do not run `build.mjs` unless a
mirrored production file changes.

**Why:** The issue forbids production-behavior change. Tests are not in
`CORE_ENTRIES`.

## Risks / Trade-offs

- [Archiving a one-off pack fixture into living specs] → Acceptable: pre-merge
  archives this change. The requirement is pack-run-scoped and does not
  generalize production FRG law.
- [Fixture string drift vs engine version] → Mitigation: the test pins
  `1.39.14` as a literal, not `package.json` version.

## Migration Plan

- Add fixture and test on this branch. No deploy step. Rollback is revert of
  the test-only commit.
