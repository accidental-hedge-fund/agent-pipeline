## 1. Fixture and unit test

- [x] 1.1 Add `core/test/frg-pack-1400-clean-openspec.test.ts` that reads only
      `core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`
      with `node:test`, `node:fs` `readFileSync`, and `JSON.parse`, asserts
      `release_version === "1.40.0"`, and verify the test fails before the
      fixture exists
- [x] 1.2 Add `core/test/fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-openspec.json`
      with `release_version` set to the exact string `1.40.0`, and verify the
      unit test now passes
- [x] 1.3 Leave production modules under `core/scripts/` unchanged, and verify
      `git diff -- core/scripts` is empty

## 2. Gate

- [ ] 2.1 After any `core/` edit run `node scripts/build.mjs`, then run
      `openspec validate pack-1400-clean-openspec` and `npm run ci` from the
      repo root, and verify both exit 0
