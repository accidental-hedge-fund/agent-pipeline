## 1. Run-scoped fixture

- [ ] 1.1 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with JSON object `{ "release_version": "1.40.1" }`. Verify the file exists, parses as JSON, and `release_version` is the string `1.40.1`.

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1401-clean-docs.test.ts` that reads that exact run-scoped path with `node:fs` `readFileSync` and `JSON.parse` (same pattern as `readme-landing-contract.test.ts`). Assert `release_version === "1.40.1"` with `node:assert/strict`. Verify `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-docs.test.ts` passes.
- [ ] 2.2 Confirm the test path is only `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`. Verify the test source does not mention any other `pack_run_id` fixture directory.
- [ ] 2.3 Confirm the test uses no network, git, or subprocess. Verify the test file does not import `node:child_process` and does not call `git` or `gh`.

## 3. Production freeze and gate

- [ ] 3.1 Leave `core/scripts/`, `hosts/`, and FRG pack templates unchanged. Verify `git diff -- core/scripts hosts core/scripts/frg-packs` is empty for this implementation.
- [ ] 3.2 Run `openspec validate frg-pack-1401-clean-docs` and `npm run ci` from the repo root. Verify both pass. Do not run `node scripts/build.mjs` unless a `core/scripts/` file was edited (it must not be).
