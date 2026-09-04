## 1. Failing unit test

- [ ] 1.1 Add `core/test/frg-pack-1401-clean-openspec.test.ts` that resolves `fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` with `fileURLToPath` + `fs.readFileSync` + `JSON.parse` (same pattern as `js-yaml-advisory-floor.test.ts`) and asserts `release_version === "1.40.1"`, and verify `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-openspec.test.ts` fails because the fixture file is absent

## 2. Run-scoped fixture

- [ ] 2.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` as a JSON object whose `release_version` is the string `1.40.1`, and verify the 1.1 test now passes
- [ ] 2.2 Temporarily set that fixture `release_version` to a different string, rerun the 1.1 test, and verify it fails, then restore `1.40.1` and verify the test passes again

## 3. Scope freeze and CI

- [ ] 3.1 Confirm the implementation diff does not edit `core/scripts/`, merge, ship, or FRG scoring modules, and verify `git diff --name-only` lists only the fixture, the new test, and this OpenSpec change
- [ ] 3.2 After the `core/` test and fixture files exist, run `node scripts/build.mjs` from the repo root, and verify `node scripts/build.mjs --check` exits 0
- [ ] 3.3 Run `openspec validate frg-pack-1401-clean-openspec` and `openspec validate --all`, and verify both exit 0
- [ ] 3.4 Run `npm run ci` from the repo root, and verify the full gate passes
