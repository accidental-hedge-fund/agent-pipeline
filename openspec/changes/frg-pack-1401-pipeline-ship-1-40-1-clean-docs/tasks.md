## 1. Run-scoped fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
  with `release_version` exactly `1.40.1`, then verify the file parses as JSON and contains that
  string value.

## 2. Executable regression test

- [ ] 2.1 Create `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts` using Node's
  test runner and strict assertions; verify by inspection that it reads only the exact run-scoped
  fixture and compares `release_version` with the literal `1.40.1`.
- [ ] 2.2 Prove the regression test bites by temporarily changing only the fixture's release value,
  running the targeted test to observe failure, restoring `1.40.1`, and rerunning the targeted test
  to observe success.

## 3. Pre-archive verification

- [ ] 3.1 Run
  `cd core && node --test --experimental-strip-types test/frg-pack-1401-pipeline-ship-1.40.1-clean-docs.test.ts`
  and verify it passes with the final fixture.
- [ ] 3.2 Run `openspec validate frg-pack-1401-pipeline-ship-1-40-1-clean-docs` and verify the
  active change is structurally valid.
- [ ] 3.3 Inspect the implementation diff and verify it changes no production behavior, foreign
  fixture, foreign issue OpenSpec change, or path outside the exact issue scope.
- [ ] 3.4 Run `npm run ci` from the repository root and verify the complete repository gate passes.
