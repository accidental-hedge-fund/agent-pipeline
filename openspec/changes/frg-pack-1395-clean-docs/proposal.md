## Why

Issue #1143 is the Factory Reliability Gate (FRG) `clean-docs` instance for pack
`pack-1395-tugboat-ship-1.39.5` on release `1.39.5`. The pack needs one clean
Pipeline path that adds a small run-scoped documentation fixture and a unit
test. The path must not change production behavior.

## What Changes

- Add a run-scoped JSON fixture at
  `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
- Add exactly one unit test file,
  `core/test/frg-pack-1395-clean-docs.test.ts`, that reads and parses only
  that fixture path and asserts `release_version === "1.39.5"`.
- Keep production engine, CLI, stage, and plugin behavior unchanged.
- Keep the existing OpenSpec change under
  `openspec/changes/frg-pack-1395-clean-docs/`. The fixture and test are
  the only functional test-content additions. Required OpenSpec metadata
  remains permitted.

## Acceptance Criteria

- [ ] File `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
      exists and is valid JSON.
- [ ] That fixture's `release_version` field equals the string `1.39.5`.
- [ ] File `core/test/frg-pack-1395-clean-docs.test.ts` exists and resolves
      only `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
      (no glob, no shared-pack lookup, no fallback path).
- [ ] That test reads and parses the JSON, then uses a strict equality
      assertion `release_version === "1.39.5"`.
- [ ] The same assertion fails when `release_version` is missing or is any
      other value (for example `1.39.4`).
- [ ] The fixture and test do not read or write any other
      `core/test/fixtures/frg/<pack_run_id>/` directory.
- [ ] `git diff -- core/scripts hosts plugin` is empty.
- [ ] `cd core && npm test` includes the new test and exits 0 on the
      committed SHA.
- [ ] `npm run ci` from the repo root exits 0 on the committed SHA.
- [ ] `openspec validate --all` exits 0.
- [ ] Engine-recorded SHA-pinned tester evidence exists for that SHA
      before any claim of a suite pass.
- [ ] Functional test-content additions are only the fixture and
      `core/test/frg-pack-1395-clean-docs.test.ts`. OpenSpec change files
      under `openspec/changes/frg-pack-1395-clean-docs/` remain permitted.

## Capabilities

### New Capabilities

- `frg-pack-1395-clean-docs`: Run-scoped `clean-docs` fixture and unit test
  for pack `pack-1395-tugboat-ship-1.39.5` on release `1.39.5`.

### Modified Capabilities

- (none)

## Impact

- **Class vs site:** This issue is a synthetic FRG pack instance
  (`template_id=clean-docs`, `pack_run_id=pack-1395-tugboat-ship-1.39.5`).
  It is not an engine-dogfood recover or ship-path fault. There is no class
  defect to fix. No shared classifier, recipe, gate, or controller changes.
  The next identical pack instance uses the same `clean-docs` template, not
  a mole issue.
- **Primary files:** `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
  and `core/test/frg-pack-1395-clean-docs.test.ts`.
- **Plugin mirror:** Not required. `scripts/build.mjs` copies `core/scripts`,
  `core/profiles`, and `core/package*.json` only. It does not copy
  `core/test/`.
- **Out of scope:** production behavior; FRG driver or pack-template edits;
  merge; FRG close-without-merge (pipeline lifecycle, not implementation);
  other pack templates (`clean-openspec`); other pack run ids.
