## 1. Fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/`.
- [ ] 1.2 Add `clean-docs.json` at that path with JSON field `release_version` set to the string `1.33.0` (optional metadata fields allowed).

## 2. Unit test

- [ ] 2.1 Add a `core/test/*.test.ts` unit test that reads only the run-scoped fixture path `core/test/fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-docs.json`.
- [ ] 2.2 Assert strict equality that parsed `release_version` is `1.33.0` (test fails if the value changes).
- [ ] 2.3 Keep the test hermetic: filesystem read of the fixture only; no network, git, or subprocess.

## 3. Verification

- [ ] 3.1 Run the new unit test (or full `core` tests) and confirm it passes with the fixture as authored.
- [ ] 3.2 Confirm the diff does not change production modules under `core/scripts/` (test/fixture only).
- [ ] 3.3 Run `npm run ci` from the repo root and fix any failures until green.
- [ ] 3.4 Confirm proposal acceptance criteria checkboxes are satisfied by the implemented artifacts and tests.
