## 1. Fixture

- [x] 1.1 Create `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json` with `{ "release": "1.39.5" }`
- [x] 1.2 Do not write any other pack-run fixture path

## 2. Unit test

- [x] 2.1 Add `core/test/frg-1395-clean-openspec.test.ts` that reads only the run-scoped fixture path
- [x] 2.2 Assert the fixture `release` field equals `1.39.5`
- [x] 2.3 Use `node:test` and `node:assert/strict`. Do not call network, git, or a subprocess

## 3. Scope and gate

- [x] 3.1 Confirm the diff does not change production scripts, CLI, stages, or config
- [x] 3.2 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 3.3 Run `openspec validate frg-1395-clean-openspec` and `npm run ci` from the repo root. Fix failures until green
