## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-docs.json` as valid JSON
- [x] 1.2 Set `release_version` on that fixture to the string `1.39.4`

## 2. Unit test

- [x] 2.1 Add a `core/test/` unit test that reads only `core/test/fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-docs.json`
- [x] 2.2 Assert the parsed fixture `release_version` equals `1.39.4`
- [x] 2.3 Confirm the test fails if that field is missing or is not `1.39.4`
- [x] 2.4 Keep the test free of real network, git, and subprocess calls

## 3. Gate

- [x] 3.1 Do not change production modules under `core/scripts/`
- [x] 3.2 If any `core/` file other than tests requires a mirror update, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 3.3 Run `openspec validate frg-1394-clean-docs` and `npm run ci` from the repo root and fix failures until green
