## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`.
- [x] 1.2 Set the fixture `release_version` field to the string `1.39.5`.
- [x] 1.3 Confirm the file parses as JSON and that no other
      `core/test/fixtures/frg/<pack_run_id>/` path is added.

## 2. Unit test

- [x] 2.1 Add `core/test/frg-pack-1395-clean-docs.test.ts` that resolves
      only `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json`
      with `node:fs` / `node:path` (no glob, no shared-pack lookup, no
      fallback path).
- [x] 2.2 Read and parse that JSON, then assert
      `release_version === "1.39.5"` with `assert.equal` from
      `node:assert/strict`.
- [x] 2.3 Prove the bite: with a temporary wrong or missing
      `release_version`, the new test fails; restore `1.39.5` before commit.
- [x] 2.4 Keep the test free of real network, git, and subprocess calls.

## 3. Gate

- [x] 3.1 Confirm `git diff -- core/scripts hosts plugin` is empty. The
      functional test-content additions are only the fixture and
      `core/test/frg-pack-1395-clean-docs.test.ts`. OpenSpec files under
      `openspec/changes/frg-pack-1395-clean-docs/` remain permitted.
- [ ] 3.2 Run `cd core && npm test` on the committed SHA and confirm the
      new test is included and passing.
- [ ] 3.3 Run `npm run ci` from the repo root and confirm it exits 0.
- [ ] 3.4 Run `openspec validate --all` and confirm it exits 0.
- [ ] 3.5 Do not claim a suite pass until the engine test-gate records
      SHA-pinned tester evidence for that SHA.
- [x] 3.6 Skip `node scripts/build.mjs` unless a copied `core/` entry was
      edited (not expected).

## 4. Out of implementation scope

- [x] 4.1 FRG close-without-merge after the run is recorded stays pipeline
      lifecycle verification. Do not implement that close path here.
