## 1. Run-scoped fixture

- [ ] 1.1 Create `core/test/fixtures/frg/frg-1.40.1-e3ab117714d1/clean-openspec.json` with `release_version` set to the literal string `1.40.1` and verify `JSON.parse` of that file yields that field

## 2. Executable unit test

- [ ] 2.1 Create `core/test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts` so it reads only that fixture, parses it, and asserts the literal `1.40.1` using Node `fs`, `JSON.parse`, `node:test`, and `node:assert/strict`
- [ ] 2.2 Prove the test bites: temporarily set the fixture `release_version` to a different value, confirm `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts` fails, then restore `1.40.1`
- [ ] 2.3 Run `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-e3ab117714d1-clean-openspec.test.ts` and verify the command exits 0

## 3. Repository gates

- [ ] 3.1 Run `openspec validate --all` from the repository root and verify it passes
- [ ] 3.2 Run `npm run ci` from the repository root and verify it passes without editing production files, another run's fixtures, or another issue's OpenSpec change
- [ ] 3.3 Inspect the product diff and verify it contains only the run-scoped fixture, the run-scoped test, and this OpenSpec change
