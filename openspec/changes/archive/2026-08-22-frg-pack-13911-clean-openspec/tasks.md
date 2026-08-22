## 1. Run-scoped fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json` with JSON object `{"release_version":"1.39.11"}`. Verify `node -e` (or equivalent) parses the file and prints `1.39.11`

## 2. Unit test

- [x] 2.1 Add `core/test/frg-pack-13911-clean-openspec.test.ts` that reads only `core/test/fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json` and asserts `release_version === "1.39.11"`. Temporarily set the fixture to another value (or omit the field) and verify `node --test --experimental-strip-types test/frg-pack-13911-clean-openspec.test.ts` fails from `core/`
- [x] 2.2 Restore `release_version` to `1.39.11`. Verify the same test command passes. The test SHALL NOT import production stage modules

## 3. Gate

- [x] 3.1 Confirm the implementation diff does not edit `core/scripts/`, `plugin/`, hosts, or merge paths. Verify `git diff --name-only` for the implementation commit lists only the fixture and the unit test (OpenSpec files already landed in planning)
- [x] 3.2 Run `openspec validate frg-pack-13911-clean-openspec` and `npm run ci` from the repo root. Verify both are green. Do not run `node scripts/build.mjs` unless a later edit touches `core/scripts/` or `core/profiles/`
