## 1. Fixture

- [x] 1.1 Create directory
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/`
- [x] 1.2 Add `clean-docs.json` with `release_version` set to the exact string
  `1.33.0`

## 2. Unit test

- [x] 2.1 Add a `core/test/` unit test that reads only
  `core/test/fixtures/frg/frg-1-33-0-d5d716355f2ed48d04aa8dde/clean-docs.json`
- [x] 2.2 Assert `release_version === "1.33.0"`
- [x] 2.3 Confirm (manually or by temporary edit) that a wrong
  `release_version` fails the test, then restore `1.33.0`

## 3. Verification

- [x] 3.1 Run the new unit test (or `cd core && npm test`) and confirm it passes
- [x] 3.2 Confirm no production files under `core/scripts/` or hosts were
  modified
- [x] 3.3 Run `openspec validate frg-1-33-0-clean-docs-fixture` and keep the
  change valid through implementation
