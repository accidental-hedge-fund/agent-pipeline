## 1. Run-scoped fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with `release_version` set to `1.40.1` and verify `node -e "JSON.parse(require('node:fs').readFileSync('core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json','utf8'))"` prints the object with that version.

## 2. Version-pinning unit test

- [ ] 2.1 Add a `core/test/` unit test that reads only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` via `node:fs` and asserts `release_version === "1.40.1"`; verify `cd core && node --test --experimental-strip-types test/<that-file>.test.ts` passes against the committed fixture.
- [ ] 2.2 Prove the test bites by temporarily setting fixture `release_version` to a non-`1.40.1` value, verifying the same test command fails, then restoring `1.40.1`.

## 3. Production-unchanged and full gate

- [ ] 3.1 Confirm `git diff -- core/scripts hosts` is empty for this implementation and verify no production CLI, stage, FRG driver, merge, or host-skill file was edited.
- [ ] 3.2 Run `node scripts/build.mjs --check` after the `core/test/` edit, then `openspec validate frg-pack-1401-clean-docs`, then `npm run ci` from the repo root, and verify all three pass.
