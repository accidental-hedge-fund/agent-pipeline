## 1. Config

- [ ] 1.1 Add `test_gate.command: "npm test && node scripts/build.mjs --check"` to `.github/pipeline.yml` under the `test_gate:` block (create the block if absent), with an inline comment noting it matches the repo's full CI command

## 2. Documentation

- [ ] 2.1 Add a sub-section to the test/build gate section of `README.md` explaining that `test_gate.command` must be set to the full CI command when CI runs additional steps beyond the auto-detected `test` script (include a one-line example with `&&` chaining)

## 3. Regression Test

- [ ] 3.1 In `core/test/testgate.test.ts`, add a test case: `test_gate.command` set to a compound command where the first part exits 0 and the second exits 1; assert the gate returns `{ passed: false }` and does not proceed to open a PR

## 4. Verify

- [ ] 4.1 Run `npm test` — all tests pass including the new regression test
- [ ] 4.2 Run `node scripts/build.mjs --check` — plugin mirror is in sync (no drift from these changes)
