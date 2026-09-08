## 1. Run-Scoped Fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json` with `release_version` exactly `1.40.1`, then parse that exact file as JSON to verify the field value.

## 2. Literal Release Regression Test

- [ ] 2.1 Create `core/test/frg-pack-1401-pipeline-ship-1.40.1-clean-openspec.test.ts` using the existing Node test conventions; make it read only the exact run-scoped fixture and assert the literal release value `1.40.1`.
- [ ] 2.2 Prove the test bites by temporarily changing the fixture release value and verifying `cd core && node --test --experimental-strip-types test/frg-pack-1401-pipeline-ship-1.40.1-clean-openspec.test.ts` fails, then restore `1.40.1` and verify the same command passes.

## 3. Implementer Verification

- [ ] 3.1 Run `openspec validate --all` from the repository root and verify all living specs and active changes pass validation.
- [ ] 3.2 Run `npm run ci` from the repository root and verify the full gate passes with changes confined to the exact fixture, test, and issue-owned OpenSpec paths.
