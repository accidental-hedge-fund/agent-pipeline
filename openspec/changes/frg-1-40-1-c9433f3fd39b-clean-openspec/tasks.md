## 1. Run-scoped fixture

- [x] 1.1 Create `core/test/fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json` with `release_version` exactly `1.40.1` and verify a parse of that file yields the literal string `1.40.1`.

## 2. Executable unit test

- [x] 2.1 Create `core/test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts` so it reads only that fixture, parses it, and asserts the literal release value `1.40.1` using existing `node:test`, `node:assert/strict`, and `fs`/`path` reads.
- [x] 2.2 Prove the test fails when the fixture `release_version` is not `1.40.1`, then restore `1.40.1` and keep that restored file.

## 3. Implementer verification

- [x] 3.1 Run `cd core && node --test --experimental-strip-types test/frg-frg-1.40.1-c9433f3fd39b-clean-openspec.test.ts` and verify it passes.
- [x] 3.2 Run `openspec validate --all` from the repository root and verify it passes.
- [ ] 3.3 Run `npm run ci` from the repository root and verify it passes.
- [x] 3.4 Verify `git diff --name-only` for product files lists only the JSON fixture, the unit test, and files under `openspec/changes/frg-1-40-1-c9433f3fd39b-clean-openspec/`.
