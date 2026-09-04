## 1. Run-scoped fixture

- [x] 1.1 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` with `release_version` set to `"1.40.1"`, and verify `JSON.parse` of that file yields `release_version === "1.40.1"`

## 2. Unit test

- [x] 2.1 Add a `core/test/` unit test that reads only that run-scoped path with `readFileSync` plus `JSON.parse` (same pattern as `declared-dependency-grammar.test.ts`) and asserts `release_version === "1.40.1"`, and verify the test fails when the fixture value is not `1.40.1`
- [x] 2.2 Leave production files under `core/scripts/` unchanged, and verify `git diff -- core/scripts` is empty

## 3. Gates

- [x] 3.1 After any `core/` edit run `node scripts/build.mjs`, and verify `node scripts/build.mjs --check` exits 0
- [x] 3.2 Run `openspec validate frg-pack-1401-clean-openspec` and `npm run ci` from the repo root, and verify both exit 0

