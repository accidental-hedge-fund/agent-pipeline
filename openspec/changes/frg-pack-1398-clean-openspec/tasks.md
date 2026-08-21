## 1. Run-scoped fixture

- [ ] 1.1 Add `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json` as valid JSON with `release_version` set to the string `1.39.8`. Verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json','utf8'))"` succeeds and the parsed `release_version` equals `1.39.8`

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1398-clean-openspec.test.ts`. The test SHALL read only `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json` and assert `release_version === "1.39.8"`. Prove the test bites: it fails if that file is missing, if `release_version` is omitted, or if the value is not `1.39.8`. Verify it does not import `core/scripts/` production modules
- [ ] 2.2 Run the new test with `cd core && node --test --experimental-strip-types test/frg-pack-1398-clean-openspec.test.ts` and verify it passes against the fixture from task 1.1

## 3. Mirror and gate

- [ ] 3.1 After the `core/` fixture and test land, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [ ] 3.2 Confirm `git diff` has no production behavior change under `core/scripts/`. Verify the only implementation files are the run-scoped fixture, the unit test, and the plugin mirror of those files
- [ ] 3.3 Run `openspec validate frg-pack-1398-clean-openspec` and `npm run ci` from the repo root. Verify both are green
