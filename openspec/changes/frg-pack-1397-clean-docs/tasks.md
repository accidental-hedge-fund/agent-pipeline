## 1. Fixture

- [ ] 1.1 Add `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json` with `release_version` set to `1.39.7` and verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-docs.json','utf8'))"` prints an object whose `release_version` is `1.39.7`

## 2. Unit test

- [ ] 2.1 Add a `core/test/` unit test that reads only that run-scoped path and asserts `release_version === "1.39.7"`, using `node:test` and `node:fs` with no network, git, or subprocess
- [ ] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different string, run the new test, and confirm it fails; restore `1.39.7` and confirm it passes
- [ ] 2.3 Confirm the test file does not reference any other `core/test/fixtures/frg/` pack-run directory

## 3. Gate

- [ ] 3.1 Confirm `git diff -- core/scripts plugin` is empty for this implementation
- [ ] 3.2 Run `openspec validate frg-pack-1397-clean-docs` and `npm run ci` from the repo root until both pass
