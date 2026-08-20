## 1. Run-scoped fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json` as valid JSON with `release_version` set to `1.39.7`. Verify by reading the file: `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json','utf8'))"` succeeds and the parsed `release_version` is `1.39.7`
- [ ] 1.2 Do not add fixtures under any other `core/test/fixtures/frg/<pack_run_id>/` path. Verify `git status` shows only the `pack-1397-tugboat-ship-1.39.7` fixture directory for this work

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1397-clean-openspec.test.ts`. The test reads that run-scoped path with `node:fs` / `JSON.parse` and asserts `release_version === "1.39.7"`. It imports no production pipeline or Factory Reliability Gate (FRG) modules. Verify with `cd core && node --test --experimental-strip-types test/frg-pack-1397-clean-openspec.test.ts`
- [ ] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different string (or delete the field), re-run the test, and confirm it fails. Restore `1.39.7` and confirm the test passes
- [ ] 2.3 Confirm the test makes no real network, git, or subprocess calls and does not reference another pack-run fixture path. Verify by reading the test source

## 3. Production freeze and gate

- [ ] 3.1 Confirm `git diff` for this implementation has no edits under `core/scripts/`, `hosts/`, or pack templates. Only the fixture, the new test, and OpenSpec archive (pre-merge) are in scope
- [ ] 3.2 Do not regenerate `plugin/` for this change: `scripts/build.mjs` copies `core/scripts`, `core/profiles`, and package files only. `core/test/` is not mirrored. Verify `node scripts/build.mjs --check` is clean without a regen unless a mirrored path also changes
- [ ] 3.3 Run `openspec validate frg-pack-1397-clean-openspec` and `npm run ci` from the repo root. Verify both are green
