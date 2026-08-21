## 1. Run-scoped fixture

- [x] 1.1 Add `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` with `release_version` set to the string `1.39.8`. Verify the file exists at that exact path and parses as JSON with `release_version === "1.39.8"`
- [x] 1.2 Do not add a fixture under any other `core/test/fixtures/frg/<pack_run_id>/` directory for this issue. Verify `git status` shows only the pack-1398 path under `fixtures/frg/`

## 2. Unit test

- [x] 2.1 Add a co-located unit test under `core/test/` that reads only `core/test/fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json` (in-process `readFileSync`, no network, git, or subprocess) and asserts `release_version` equals `1.39.8`. Verify the test passes when the fixture holds `1.39.8`
- [x] 2.2 Prove the test bites: temporarily set the fixture `release_version` (or the assertion) to a value other than `1.39.8`, run the test, and confirm it fails. Restore `1.39.8` and confirm the test passes
- [x] 2.3 Confirm the test file does not import or call production FRG driver APIs and does not edit `core/scripts/`. Verify `git diff -- core/scripts` is empty

## 3. Gate

- [x] 3.1 Run `node scripts/build.mjs` after the `core/test/` add and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 3.2 Run `openspec validate frg-pack-1398-clean-docs` and `npm run ci` from the repo root. Verify both are green
