## 1. Fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/`
- [ ] 1.2 Add `clean-openspec.json` with top-level `"release_version": "1.33.0"` (optional companion fields `pack_run_id` / `template_id` allowed for readability)

## 2. Unit test

- [ ] 2.1 Add a co-located unit test under `core/test/` that reads only the run-scoped fixture path from task 1.2
- [ ] 2.2 Assert `release_version === "1.33.0"`; confirm the test fails if the field is wrong or missing (bite check)
- [ ] 2.3 Confirm the test performs no real network, git, or subprocess I/O

## 3. Verification

- [ ] 3.1 Run the new unit test (and broader `cd core && npm test` if practical) and confirm green
- [ ] 3.2 Confirm no production files under `core/scripts/` (excluding tests/fixtures) were modified for this issue
- [ ] 3.3 Run `openspec validate frg-1-33-0-clean-openspec` and keep the change valid through implement
- [ ] 3.4 Run `npm run ci` from repo root until green (no `plugin/` regen expected if core production sources are untouched)

## 4. OpenSpec archive readiness (pre-merge stage)

- [ ] 4.1 Ensure this is the only active OpenSpec change belonging to issue #933
- [ ] 4.2 Leave archive to the pipeline pre-merge stage (no foreign active change remaining after archive)
