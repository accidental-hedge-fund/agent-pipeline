## 1. Run-scoped fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json` as valid JSON with `release_version` equal to `"1.39.6"` and verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json','utf8'))"` succeeds from the repo root.

## 2. Unit test

- [ ] 2.1 Add a `core/test/*.test.ts` file that reads only `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json`, parses JSON, and asserts `release_version === "1.39.6"`.
- [ ] 2.2 Prove the test bites: temporarily set `release_version` to a different value (or omit it), run the new test, and confirm it fails; restore `1.39.6` and confirm it passes.
- [ ] 2.3 Confirm the test file performs no network, git, or subprocess calls.

## 3. Scope and CI

- [ ] 3.1 Confirm `git diff --name-only` for the implementation commit lists only the fixture, the new test, and OpenSpec files (no `core/scripts/`, `hosts/`, or `plugin/` edits).
- [ ] 3.2 Run `cd core && npm test` and confirm the new test is included and the suite passes.
- [ ] 3.3 Run `npm run ci` from the repo root and confirm it is green (`build.mjs --check` included; no mirror regen needed).
