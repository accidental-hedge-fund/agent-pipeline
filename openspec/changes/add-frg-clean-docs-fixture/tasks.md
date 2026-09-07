## 1. Add Run-Scoped Evidence

- [x] 1.1 Add `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json` with `release_version` equal to `1.40.1`, then parse the file to verify it is valid JSON with the expected value.
- [x] 1.2 Add one colocated Node unit test that resolves only the exact run-scoped fixture, parses it, and asserts the literal `1.40.1` value; run that test and verify it passes.
- [x] 1.3 Temporarily change the fixture version, verify the dedicated test fails, restore `1.40.1`, and rerun the test to verify the regression guard bites without leaving the mutation in the diff.

## 2. Verify Scope and Repository Gates

- [x] 2.1 Inspect the implementation diff and verify that non-OpenSpec changes comprise only the run-scoped fixture and its unit test, with no production behavior changes.
- [ ] 2.2 Run `node scripts/build.mjs`, `openspec validate --all`, and `npm run ci` from the repository root; verify generated hosts remain fresh and every required gate passes.

## 3. Verify FRG Lifecycle

- [ ] 3.1 Advance the issue through the full Pipeline and verify it reaches `pipeline:ready-to-deploy` with the successful test evidence recorded.
- [ ] 3.2 After the FRG records the run, verify the pull request and issue are closed and the pull request merge state is unmerged.
