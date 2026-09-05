## 1. Biting unit test

- [x] 1.1 Add `core/test/frg-pack-1401-clean-docs.test.ts` that reads
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
      via `import.meta.url`, parses JSON, and asserts `release_version === "1.40.1"`.
      Verify the test **fails** before the fixture exists (`cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-docs.test.ts`).
- [x] 1.2 Confirm the test file path string is only that run-scoped fixture
      (no other `core/test/fixtures/frg/` pack-run directory). Verify with a
      search of the new test file for `fixtures/frg`. Confirm the test performs
      no real network, git, or subprocess calls (no `spawn` / `gh` / `git`).

## 2. Run-scoped fixture

- [x] 2.1 Create
      `core/test/fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json`
      as JSON with `release_version` set to the string `1.40.1`. Verify
      `JSON.parse` of that file yields `release_version === "1.40.1"`.
- [x] 2.2 Re-run `cd core && node --test --experimental-strip-types test/frg-pack-1401-clean-docs.test.ts`
      and verify it **passes** with the fixture in place. Verify changing the
      fixture value to a different string makes the same command fail, then
      restore `1.40.1`.

## 3. Scope and gate

- [x] 3.1 Confirm `git diff` against the issue base has no edits under
      `core/scripts/` or `hosts/`, and does not create `plugin/`. Verify
      `node scripts/build.mjs --check` still passes without a host SKILL
      regeneration for this change.
- [x] 3.2 Confirm the only active OpenSpec change is `frg-pack-1401-clean-docs`
      (`openspec list` shows that id alone). Verify
      `openspec validate frg-pack-1401-clean-docs` passes.
- [x] 3.3 Run `npm run ci` from the repo root and verify it is green.
