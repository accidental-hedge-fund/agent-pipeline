## 1. Biting unit test

- [ ] 1.1 Add a co-located test under `core/test/` that reads only
      `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
      via `node:fs` and `JSON.parse`, then asserts `release_version` is the
      exact string `1.39.12`. Verify the test fails when that file is absent
      or when `release_version` is any other value. Do not import production
      modules. Do not read any other `pack_run_id` path

## 2. Run-scoped fixture

- [ ] 2.1 Create
      `core/test/fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json`
      as JSON with `release_version` set to `"1.39.12"`. Verify task 1.1 now
      passes. Do not edit `core/scripts/`

## 3. Gate

- [ ] 3.1 Run `openspec validate frg-pack-13912-clean-openspec` and
      `npm run ci` from the repo root. Verify both are green. Verify
      `git diff` against the issue base has no production edits under
      `core/scripts/` and no hand-edits under `plugin/`. Do not add a second
      active OpenSpec change. Do not archive this change in the implement
      step (pre-merge archives it)
