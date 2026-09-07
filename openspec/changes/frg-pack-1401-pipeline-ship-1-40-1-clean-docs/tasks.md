## 1. Run-scoped fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with `release_version` exactly `1.40.1`, then parse the file to verify the stored literal.

## 2. Executable conformance test

- [x] 2.1 Create `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts` so it reads only the exact run-scoped fixture and asserts the literal `1.40.1`, with no network, git, or subprocess I/O.
- [x] 2.2 Run `cd core && node --test --experimental-strip-types test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts`, then temporarily change the fixture release value and rerun to verify the test fails before restoring `1.40.1` and confirming it passes.

## 3. Repository verification

- [ ] 3.1 Run `npm run ci` from the repository root and verify the complete gate passes.
- [ ] 3.2 Inspect the final diff and verify implementation changes are limited to the exact run-scoped fixture and test paths plus this issue's OpenSpec change.
