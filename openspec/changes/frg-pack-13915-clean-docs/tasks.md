## 1. Fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json` with `release_version` set to the string `1.39.15` and verify the file parses as JSON
- [ ] 1.2 Confirm the fixture path is only `core/test/fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-docs.json` (no other pack-run directory)

## 2. Pinning test

- [ ] 2.1 Add a hermetic `core/test/frg-pack-13915-clean-docs.test.ts` (or equivalent co-located `core/test/*.test.ts`) that reads only that fixture path and asserts `release_version === "1.39.15"`
- [ ] 2.2 Temporarily set `release_version` to a different string, run the new test, confirm it fails, then restore `1.39.15` and confirm the test passes
- [ ] 2.3 Confirm the test does not call real network, git, or subprocess APIs

## 3. Scope guard

- [ ] 3.1 Confirm the implementation diff does not edit `core/scripts/`, FRG scoring, release preflight, or `plugin/`
- [ ] 3.2 Do not create a second OpenSpec change for issue #1290

## 4. Verification

- [ ] 4.1 Run `npm run ci` from the repo root and ensure it is green
- [ ] 4.2 Spot-check acceptance criteria in `proposal.md` against the landed diff
