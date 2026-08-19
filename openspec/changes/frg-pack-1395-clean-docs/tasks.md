## 1. Fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
- [ ] 1.2 Set the fixture `release_version` field to the string `1.39.5`.
- [ ] 1.3 Confirm the file parses as JSON and that no other
      `core/test/fixtures/frg/<pack_run_id>/` path is added.

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1395-clean-docs.test.ts` that reads only the
      run-scoped fixture path with `node:fs` / `node:path`.
- [ ] 2.2 Assert the parsed `release_version` equals `1.39.5`.
- [ ] 2.3 Prove the bite: with a temporary wrong or missing
      `release_version`, the new test fails; restore `1.39.5` before commit.
- [ ] 2.4 Keep the test free of real network, git, and subprocess calls.

## 3. Gate

- [ ] 3.1 Confirm `git diff --name-only` lists only the fixture, the new
      test, and this OpenSpec change. No `core/scripts/`, `hosts/`, or
      `plugin/` edits.
- [ ] 3.2 Run `cd core && npm test` and confirm the new test is included
      and passing.
- [ ] 3.3 Run `npm run ci` from the repo root and confirm it exits 0.
- [ ] 3.4 Skip `node scripts/build.mjs` unless a copied `core/` entry was
      edited (not expected).
