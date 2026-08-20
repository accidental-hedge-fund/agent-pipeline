## 1. Fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/` and add `clean-openspec.json` with `release_version` set to `"1.39.6"`; verify the file exists at that exact path and parses as JSON
- [ ] 1.2 Confirm the fixture uses only that run-scoped path (no shared `core/test/fixtures/frg/clean-openspec.json` or other pack-run directory); verify `git ls-files --others --exclude-standard` shows only the pack-1396 path under `core/test/fixtures/frg/`

## 2. Unit test

- [ ] 2.1 Add a co-located `core/test/` unit test that reads `core/test/fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json` and asserts `release_version === "1.39.6"`; verify the test fails if that field is changed
- [ ] 2.2 Keep the test free of real network, git, and subprocess calls; verify it uses repo-local file read only

## 3. Production freeze and gate

- [ ] 3.1 Confirm no production module under `core/scripts/` is edited for this issue; verify `git diff --stat -- core/scripts/` is empty except any accidental edit, which must be reverted
- [ ] 3.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change; verify `node scripts/build.mjs --check` passes
- [ ] 3.3 Run `openspec validate frg-pack-1396-clean-openspec` and `npm run ci` from the repo root; verify both are green
