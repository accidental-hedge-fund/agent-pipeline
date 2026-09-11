## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json` with `release_version` exactly `1.40.1`, and verify by reading the parsed JSON that the field equals `1.40.1`

## 2. Unit test

- [x] 2.1 Create `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` that reads only that fixture, parses it, and asserts the literal release value, and verify `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-docs.test.ts` exits 0
- [x] 2.2 Temporarily change the fixture `release_version` to a different value, verify the same test command fails, then restore `1.40.1` and verify the test exits 0 again

## 3. CI

- [x] 3.1 Run `npm run ci` from the repository root and verify it exits 0 without edits to production scripts, classifiers, recovery recipes, gates, controllers, or another run's files
