## 1. Fixture and unit test

- [ ] 1.1 Add `core/test/frg-pack-1401-clean-openspec.test.ts` that reads only
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
      with `node:test`, `node:fs` `readFileSync`, and `JSON.parse`, asserts
      `release_version === "1.40.1"`, and verify the test fails before the
      fixture exists (`cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-openspec.test.ts`)
- [ ] 1.2 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
      with `release_version` set to the exact string `1.40.1`, and verify the
      unit test now passes. Verify the same assertion fails if
      `release_version` is edited to another value, then restore `1.40.1`
- [ ] 1.3 Confirm the test file path string is only that run-scoped fixture
      (no other `core/test/fixtures/frg/` pack-run directory). Verify the
      test performs no real network, git, or subprocess calls
- [ ] 1.4 Leave production modules under `core/scripts/` and `hosts/`
      unchanged, and verify `git diff -- core/scripts hosts` is empty and
      `plugin/` is not recreated

## 2. Gate

- [ ] 2.1 Confirm `openspec validate pack-1401-clean-openspec` exits 0, then
      run `npm run ci` from the repo root and verify it is green. Run
      `node scripts/build.mjs` only if a later `core/` edit happens; this
      change does not require that edit
