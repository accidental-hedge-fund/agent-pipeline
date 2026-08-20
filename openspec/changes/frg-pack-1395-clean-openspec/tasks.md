## 1. Run-scoped fixture

- [ ] 1.1 Create directory `core/test/fixtures/frg/pack-1395-tugboat-ship-1.39.5/`
- [ ] 1.2 Add `clean-openspec.json` with `release_version` set to the exact string `1.39.5`
- [ ] 1.3 Include identity fields `pack_run_id` (`pack-1395-tugboat-ship-1.39.5`) and `template_id` (`clean-openspec`)

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1395-clean-openspec.test.ts`
- [ ] 2.2 Read only that run-scoped fixture path, parse JSON, and assert `release_version === "1.39.5"`
- [ ] 2.3 Prove the test fails if `release_version` is missing or not `1.39.5` (the test bites)
- [ ] 2.4 Do not call network, git, or subprocess. Do not import production stage code

## 3. Scope and gate

- [ ] 3.1 Confirm no edits under `core/scripts/`, `hosts/`, or `plugin/`
- [ ] 3.2 Confirm this is the only active OpenSpec change (`openspec/changes/frg-pack-1395-clean-openspec`)
- [ ] 3.3 Run `openspec validate frg-pack-1395-clean-openspec` and `npm run ci` from the repo root. Fix until green
