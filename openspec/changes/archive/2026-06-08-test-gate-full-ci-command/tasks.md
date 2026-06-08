## 1. Config

- [x] 1.1 Add a `"ci"` script to root `package.json` that runs `npm test && node scripts/build.mjs --check`, then add `test_gate.command: "npm run ci"` to `.github/pipeline.yml` under the `test_gate:` block (create the block if absent), with an inline comment noting it matches the repo's full CI command. Note: `shellSplit` tokenizes the command without shell semantics, so `&&` must live inside an npm script — not raw in the config value.

## 2. Documentation

- [x] 2.1 Add a sub-section to the test/build gate section of `README.md` explaining that `test_gate.command` must be set to cover the full CI surface when CI runs steps beyond the auto-detected `test` script. Note that `test_gate.command` is parsed without a shell, so compound commands must be wrapped in a single script (e.g. `npm run ci`). Include a one-line example.

## 3. Regression Test

- [x] 3.1 In `core/test/testgate.test.ts`, add a test case: `test_gate.command` set to a compound command where the first part exits 0 and the second exits 1; assert the gate returns `{ passed: false }` and does not proceed to open a PR

## 4. Verify

- [x] 4.1 Run `npm test` — all tests pass including the new regression test
- [x] 4.2 Run `node scripts/build.mjs --check` — plugin mirror is in sync (no drift from these changes)
