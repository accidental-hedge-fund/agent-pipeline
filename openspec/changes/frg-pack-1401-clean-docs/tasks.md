## 1. Biting unit test

- [ ] 1.1 Add `core/test/frg-pack-1401-clean-docs.test.ts` that uses `node:test`, `node:fs` `readFileSync`, and `JSON.parse` (same pattern as `core/test/version.test.ts`). Resolve `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` from `import.meta.url`. Assert `release_version` equals `"1.40.1"`. Do not add a fixture-loader helper. Do not call network, git, or a subprocess. Verify the test **fails** while that fixture file is absent (`cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-docs.test.ts`).

## 2. Run-scoped fixture

- [ ] 2.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` as valid JSON whose `release_version` is the string `1.40.1`. Do not place it under a different pack-run directory. Verify task 1.1 now **passes** against this file. Verify the same assertion **fails** if `release_version` is edited to another value, then restore `1.40.1`.

## 3. Production freeze and gate

- [ ] 3.1 Confirm `git diff --stat` has no edits under `core/scripts/`. After any `core/` add, run `node scripts/build.mjs` from the repo root so host SKILL freshness matches. Verify `node scripts/build.mjs --check` is clean, `openspec validate frg-pack-1401-clean-docs` passes, and `npm run ci` from the repo root is green.
