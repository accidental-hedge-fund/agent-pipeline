## 1. Fixture and unit test

- [ ] 1.1 Add `core/test/frg-pack-1401-clean-openspec.test.ts` that reads only
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
      with `node:test`, `node:fs` `readFileSync`, and `JSON.parse`, asserts
      `release_version === "1.40.1"`, and verify
      `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-openspec.test.ts`
      fails before the fixture exists
- [ ] 1.2 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json`
      with `release_version` set to the exact string `1.40.1`, and verify the
      same unit test command now passes
- [ ] 1.3 Prove the test bites by temporarily setting fixture
      `release_version` to a non-`1.40.1` value, verifying the same test
      command fails, then restoring `1.40.1`
- [ ] 1.4 Confirm the test file path string is only that run-scoped fixture
      (no other `core/test/fixtures/frg/` pack-run directory). Verify the
      test performs no real network, git, or subprocess calls
- [ ] 1.5 Leave production modules under `core/scripts/` and `hosts/`
      unchanged, and verify `git diff -- core/scripts hosts` is empty and
      `plugin/` is not recreated

## 2. Gate

- [ ] 2.1 Confirm `openspec validate frg-pack-1401-clean-openspec` exits 0,
      then run `npm run ci` from the repo root and verify it is green. Run
      `node scripts/build.mjs` only if a later `core/` edit happens; this
      change does not require that edit
