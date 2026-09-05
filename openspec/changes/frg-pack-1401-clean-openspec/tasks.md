## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` with `release_version` set to `1.40.1`, and verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json','utf8'))"` prints an object whose `release_version` is `1.40.1`

## 2. Unit test

- [x] 2.1 Add a `node:test` file under `core/test/` that reads only that run-scoped path with `fs.readFileSync` and `JSON.parse`, asserts `release_version === "1.40.1"`, and verify the test fails if that field is changed
- [x] 2.2 Restore `release_version` to `1.40.1` and verify the new test passes under `cd core && node --test --experimental-strip-types test/<that-file>.test.ts`

## 3. Production freeze and CI

- [x] 3.1 Confirm `git diff -- core/scripts/` is empty for this implementation, and verify no production module changed
- [x] 3.2 Run `openspec validate frg-pack-1401-clean-openspec` and `npm run ci` from the repo root, and verify both exit 0
