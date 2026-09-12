## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-docs.json` with `release_version` exactly `1.40.1` and verify by parsing the file that the field equals `1.40.1`

## 2. Unit test

- [x] 2.1 Create `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-docs.test.ts` so it reads only that fixture, parses it, and asserts the literal release value `1.40.1`
- [x] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different value, confirm `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-docs.test.ts` fails, then restore `1.40.1`
- [x] 2.3 Run `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-docs.test.ts` and verify it exits 0

## 3. CI

- [ ] 3.1 Run `npm run ci` from the repository root and verify it exits 0 without editing production files, another run's fixtures, or another issue's OpenSpec change
