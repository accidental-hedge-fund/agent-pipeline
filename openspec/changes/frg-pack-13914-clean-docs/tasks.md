## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json` with `release_version` equal to `1.39.14` and verify `node -e 'JSON.parse(require("fs").readFileSync("core/test/fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json","utf8"))'` parses and prints `1.39.14`.

## 2. Unit test

- [x] 2.1 Add a `core/test/*.test.ts` that reads only that run-scoped path and asserts `release_version === "1.39.14"`; verify `cd core && node --test --experimental-strip-types test/<that-file>.test.ts` passes, and that changing the fixture value to a different string makes the same command fail.
- [x] 2.2 Confirm the new test performs no real network, git, or subprocess calls (no `spawn` / `gh` / `git` in the test file) and does not import production stage modules.

## 3. Gate

- [x] 3.1 Confirm `git diff -- core/scripts` is empty (production behavior unchanged).
- [x] 3.2 Run `npm run ci` from the repo root and fix failures until it exits 0. If any `core/scripts/` file was edited, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
