## 1. Run-scoped fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/`.
- [ ] 1.2 Add `clean-openspec.json` at that path with top-level `"release_version": "1.33.0"`
      (valid JSON; optional provenance keys allowed per design).
- [ ] 1.3 Confirm no other pack-run directories under `core/test/fixtures/frg/` are created or
      modified by this change.

## 2. Unit test

- [ ] 2.1 Add a `node --test` case under `core/test/` that reads **only**
      `fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json` and asserts
      `release_version === "1.33.0"`.
- [ ] 2.2 Keep the test free of real network, git, and subprocess calls.
- [ ] 2.3 Prove the assertion bites: temporarily set `release_version` to a non-`1.33.0`
      value, observe test failure, then restore.

## 3. Production surface check

- [ ] 3.1 Confirm the implementation diff does not change files under `core/scripts/`,
      `hosts/`, or runtime config (OpenSpec change artifacts + fixture + test only).
- [ ] 3.2 Skip `node scripts/build.mjs` unless a mirrored production path was unexpectedly
      touched.

## 4. Verification and close-out

- [ ] 4.1 Run `cd core && npm test` and confirm the new case passes with the suite.
- [ ] 4.2 Run `npm run ci` from the repo root and confirm green.
- [ ] 4.3 Run `openspec validate frg-clean-openspec-1-33-0` (and ensure `openspec validate
      --all` still passes with this active change).
- [ ] 4.4 Re-read proposal acceptance criteria and confirm each is satisfied with evidence
      (archive and `pipeline:ready-to-deploy` are pipeline-stage outcomes after implement).
