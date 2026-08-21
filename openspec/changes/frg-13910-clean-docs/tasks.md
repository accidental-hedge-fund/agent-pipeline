## 1. Run-scoped fixture

- [ ] 1.1 Add `core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json` with JSON object `{"release_version":"1.39.10"}` and verify `node -e "JSON.parse(require('fs').readFileSync('core/test/fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-docs.json','utf8'))"` succeeds and prints `release_version` `1.39.10`

## 2. Pinning unit test

- [ ] 2.1 Add `core/test/frg-clean-docs-pack-13910.test.ts` that reads only that fixture path and asserts `release_version === "1.39.10"`. Verify `cd core && node --test --experimental-strip-types test/frg-clean-docs-pack-13910.test.ts` passes
- [ ] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different string, re-run the same test command, and verify it fails. Restore `1.39.10` and verify the test passes again

## 3. Scope and gate

- [ ] 3.1 Confirm `git diff -- core/scripts` is empty. If any `core/scripts/` or `hosts/claude` file was edited, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 3.2 Run `openspec validate frg-13910-clean-docs` and `npm run ci` from the repo root. Verify both are green
