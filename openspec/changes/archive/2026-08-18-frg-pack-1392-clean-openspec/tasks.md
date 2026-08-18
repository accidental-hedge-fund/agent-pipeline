## 1. Fixture

- [x] 1.1 Add `core/test/fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json`
- [x] 1.2 Set `release_version` in that file to the exact string `1.39.2`

## 2. Unit test

- [x] 2.1 Add `core/test/frg-pack-1392-clean-openspec.test.ts`
- [x] 2.2 Read only the run-scoped fixture path and assert `release_version` is `1.39.2`
- [x] 2.3 Prove the test fails when `release_version` is not `1.39.2`
- [x] 2.4 Do not import or change production pipeline modules

## 3. Mirror and gate

- [x] 3.1 After the `core/` files exist, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 3.2 Run `openspec validate frg-pack-1392-clean-openspec` and `npm run ci` from the repo root
- [x] 3.3 Confirm this is the only active OpenSpec change
