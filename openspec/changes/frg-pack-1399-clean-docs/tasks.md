## 1. Run-scoped fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/` and write `clean-docs.json` with `release_version` set to the string `1.39.9`. Verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json','utf8'))"` succeeds and prints an object whose `release_version` is `1.39.9`

## 2. Unit test

- [ ] 2.1 Add a co-located `node:test` file under `core/test/` that reads only `core/test/fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json` (path relative to the test file or repo root via `import.meta.url`) and asserts `release_version === "1.39.9"`. Use `fs.readFileSync` and `JSON.parse`. Do not call network, git, or subprocess. Verify `cd core && node --test --experimental-strip-types test/<that-file>.test.ts` passes with the fixture at `1.39.9`
- [ ] 2.2 Prove the test bites: temporarily set fixture `release_version` to a different string (or delete the field), rerun the same test command, and confirm it fails. Restore `1.39.9` and confirm the test passes again

## 3. Scope and gate

- [ ] 3.1 Confirm `git diff --name-only` for implementation files lists only the new fixture, the new test, and this OpenSpec change (no `core/scripts/` edits, no hand-edits under `plugin/`). Verify `node scripts/build.mjs --check` still passes without regenerating the mirror
- [ ] 3.2 Run `openspec validate frg-pack-1399-clean-docs` and `npm run ci` from the repo root. Verify both are green
