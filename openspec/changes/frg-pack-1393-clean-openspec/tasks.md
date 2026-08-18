## 1. Fixture

- [ ] 1.1 Create `core/test/fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json`
- [ ] 1.2 Set `release_version` to the exact string `1.39.3`. Optional identity fields may include `pack_run_id` and `template_id`

## 2. Unit test

- [ ] 2.1 Add `core/test/frg-pack-1393-clean-openspec.test.ts`
- [ ] 2.2 Read only the run-scoped fixture path with `node:fs` / `node:path` and assert `release_version === "1.39.3"`
- [ ] 2.3 Prove the test fails if `release_version` is missing or not `1.39.3`
- [ ] 2.4 Make no network, git, or subprocess calls. Do not edit production modules under `core/scripts/`

## 3. Gate

- [ ] 3.1 Run `openspec validate frg-pack-1393-clean-openspec` and `npm run ci` from the repo root. Fix failures until green
- [ ] 3.2 Confirm this issue has no other active OpenSpec change and no production behavior diff
