## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json` as valid JSON
- [x] 1.2 Set `release_version` on that fixture to the string `1.39.2`

## 2. Unit test

- [x] 2.1 Add a `core/test/*.test.ts` that reads only `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-docs.json`
- [x] 2.2 Assert `release_version` equals `1.39.2` so a missing or changed value fails the test
- [x] 2.3 Confirm the test uses no other `core/test/fixtures/frg/<pack_run_id>/` path

## 3. Verify

- [x] 3.1 Prove the new test fails if `release_version` is changed, then restore `1.39.2`
- [x] 3.2 Confirm the diff does not change production files under `core/scripts/`
- [x] 3.3 Run `openspec validate frg-pack-1392-clean-docs` and `npm run ci` from the repo root and fix failures until green
