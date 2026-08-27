## 1. Biting unit test

- [x] 1.1 Add `core/test/frg-13913-clean-openspec.test.ts` that reads
      `core/test/fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json`
      via `import.meta.url`, parses JSON, and asserts `release_version === "1.39.13"`.
      Verify the test **fails** before the fixture exists (`cd core && node --test --experimental-strip-types test/frg-13913-clean-openspec.test.ts`).
- [x] 1.2 Confirm the test file path string is only that run-scoped fixture
      (no other `core/test/fixtures/frg/` pack-run directory). Verify with a
      search of the new test file for `fixtures/frg`.

## 2. Run-scoped fixture

- [x] 2.1 Create
      `core/test/fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json`
      as JSON with `release_version` set to the string `1.39.13`. Verify
      `JSON.parse` of that file yields `release_version === "1.39.13"`.
- [x] 2.2 Re-run `cd core && node --test --experimental-strip-types test/frg-13913-clean-openspec.test.ts`
      and verify it **passes** with the fixture in place.

## 3. Scope and gate

- [x] 3.1 Confirm `git diff` against the issue base has no edits under
      `core/scripts/`, `hosts/`, or `plugin/`. Verify
      `node scripts/build.mjs --check` still passes without regenerating the
      plugin for this change.
- [x] 3.2 Confirm the only active OpenSpec change is `frg-13913-clean-openspec`
      (`openspec list` shows that id alone). Verify
      `openspec validate frg-13913-clean-openspec` passes.
- [x] 3.3 Run `npm run ci` from the repo root and verify it is green.
