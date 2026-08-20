## 1. Run-scoped fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json` as valid JSON with `release_version` set to `1.39.7`. Verify by reading the file: `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json','utf8'))"` succeeds and the parsed `release_version` is `1.39.7`
- [x] 1.2 Do not add fixtures under any other `core/test/fixtures/frg/<pack_run_id>/` path. Verify `git status` shows only the `pack-1397-tugboat-ship-1.39.7` fixture directory for this work

## 2. Unit test

- [x] 2.1 Add `core/test/frg-pack-1397-clean-openspec.test.ts`. The test reads that run-scoped path with `node:fs` / `JSON.parse` and asserts `release_version === "1.39.7"`. It imports no production pipeline or Factory Reliability Gate (FRG) modules. Verify with `cd core && node --test --experimental-strip-types test/frg-pack-1397-clean-openspec.test.ts`
- [x] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different string (or delete the field), re-run the test, and confirm it fails. Restore `1.39.7` and confirm the test passes
- [x] 2.3 Confirm the test makes no real network, git, or subprocess calls and does not reference another pack-run fixture path. Verify by reading the test source

## 3. Production freeze and gate

- [x] 3.1 Confirm `git diff` for this implementation has no edits under `core/scripts/`, `hosts/`, or pack templates. Only the fixture, the new test, regenerated `plugin/` (if the test is mirrored), and OpenSpec archive (pre-merge) are in scope
- [x] 3.2 After any `core/` edit, run `node scripts/build.mjs` from the repo root and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean
- [x] 3.3 Run `openspec validate frg-pack-1397-clean-openspec` and `npm run ci` from the repo root. Verify both are green
