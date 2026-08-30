## 1. Fixture and unit test

- [ ] 1.1 Add `core/test/frg-pack-13916-clean-openspec.test.ts` that reads only
      `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
      with `node:test`, `node:fs` `readFileSync`, and `JSON.parse`, asserts
      `release_version === "1.39.16"`, and verify the test fails before the
      fixture exists
- [ ] 1.2 Add `core/test/fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-openspec.json`
      with `release_version` set to the exact string `1.39.16`, and verify the
      unit test now passes
- [ ] 1.3 Leave production modules under `core/scripts/` unchanged, and verify
      `git diff -- core/scripts` is empty

## 2. Gate

- [ ] 2.1 After any `core/` edit run `node scripts/build.mjs`, then run
      `openspec validate pack-13916-clean-openspec` and `npm run ci` from the
      repo root, and verify both exit 0
