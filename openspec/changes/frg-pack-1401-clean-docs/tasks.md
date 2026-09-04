## 1. Run-scoped fixture

- [ ] 1.1 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with `release_version` set to the string `1.40.1`, and verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json','utf8'))"` prints an object whose `release_version` is `1.40.1`

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1401-clean-docs.test.ts` that reads only that run-scoped path with `node:fs` `readFileSync` and `JSON.parse`, asserts `release_version === "1.40.1"`, and verify `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-docs.test.ts` exits 0
- [ ] 2.2 Temporarily set the fixture `release_version` to a different string, rerun the same test command, verify it exits non-zero, then restore `1.40.1` and verify the test passes again

## 3. Scope and CI

- [ ] 3.1 Confirm `git diff --name-only` lists no production files under `core/scripts/`, and verify no new public CLI verb was added
- [ ] 3.2 Run `openspec validate frg-pack-1401-clean-docs` and `npm run ci` from the repo root, and verify both exit 0
