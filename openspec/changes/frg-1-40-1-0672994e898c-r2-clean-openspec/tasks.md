## 1. Run-scoped fixture

- [x] 1.1 Create `core/test/fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-openspec.json` with `release_version` set to the literal string `1.40.1` and verify `JSON.parse` of that file yields that field.

## 2. Executable unit test

- [x] 2.1 Create `core/test/frg-frg-1.40.1-0672994e898c-r2-clean-openspec.test.ts` so it reads only that fixture, parses it, and asserts the literal `1.40.1` using Node `fs`, `JSON.parse`, `node:test`, and `node:assert/strict`.
- [x] 2.2 Run `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-0672994e898c-r2-clean-openspec.test.ts` and verify the command passes.
- [x] 2.3 Inspect the assertion and verify it compares against the literal string `1.40.1`, so a changed fixture `release_version` fails the test.

## 3. Repository gates

- [x] 3.1 Run `openspec validate --all` from the repository root and verify it passes.
- [ ] 3.2 Run `npm run ci` from the repository root and verify it passes.
- [x] 3.3 Inspect the product diff and verify it contains only the run-scoped fixture, the run-scoped test, and this OpenSpec change.
