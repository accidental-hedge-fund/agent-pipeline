## 1. Run-scoped fixture

- [ ] 1.1 Add JSON file `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json` with `release_version` set to the string `1.39.12`. Verify `node -e "const j=require('./core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json'); if (j.release_version!=='1.39.12') process.exit(1)"` exits 0

## 2. Unit test that bites the version pin

- [ ] 2.1 Add a co-located unit test under `core/test/` that reads only `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json` and asserts `release_version` equals `1.39.12`. Verify the test fails if that field is changed (temporarily set it to another value, run the test, then restore `1.39.12`)
- [ ] 2.2 Confirm the test file hard-codes that pack-run path (no sibling `core/test/fixtures/frg/<other-pack>/` path). Verify `rg -n "pack-13912-tugboat-ship-1.39.12/clean-docs.json" core/test/*.test.ts` matches the new test

## 3. Gate

- [ ] 3.1 Confirm this change does not edit `core/scripts/`, `hosts/`, or `plugin/`. Verify `git diff --name-only` lists only the fixture, the new test, and OpenSpec files
- [ ] 3.2 Run `openspec validate frg-pack-13912-clean-docs` and `npm run ci` from the repo root. Verify both are green. Do not regenerate `plugin/` unless a `core/scripts/` file was edited
