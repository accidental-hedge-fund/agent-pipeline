## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` as valid JSON with `"release_version": "1.40.1"`, and verify `node -e "const f=require('./core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json'); if (f.release_version!=='1.40.1') process.exit(1)"` exits 0
- [x] 1.2 Confirm no other file exists under a sibling `core/test/fixtures/frg/<other-pack-run>/` path for this change, and verify `git diff --name-only` lists only the pack-1401 fixture under `core/test/fixtures/frg/`

## 2. Unit test

- [x] 2.1 Add `core/test/frg-pack-1401-clean-openspec.test.ts` that reads only that run-scoped path via `readFileSync` + `JSON.parse` and asserts `release_version === "1.40.1"`, and verify `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-openspec.test.ts` passes
- [x] 2.2 Prove the test bites: temporarily set `release_version` to a different string, rerun the same test command, and verify it fails; then restore `1.40.1` and verify the test passes again

## 3. Production freeze and CI

- [x] 3.1 Confirm `git diff -- core/scripts` is empty, and verify no new CLI verb, stage, label, or merge path was added
- [x] 3.2 Run `openspec validate frg-pack-1401-clean-openspec` and `npm run ci` from the repo root, and verify both exit 0
