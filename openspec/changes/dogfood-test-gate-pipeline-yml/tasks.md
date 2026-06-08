## 1. Configure .github/pipeline.yml

- [ ] 1.1 Add `test_gate.command: "npm run ci"` to `.github/pipeline.yml`
- [ ] 1.2 Add an inline comment on or near `test_gate.command` explaining that the value matches this repo's full CI command and why a single-token npm script is required (no shell semantics)

## 2. Add ci script to package.json

- [ ] 2.1 Add a `ci` script to `package.json` that runs `npm test && node scripts/build.mjs --check && npm run ci:install-smoke` (or equivalent), matching all three steps in `.github/workflows/ci.yml`
- [ ] 2.2 Add a `ci:install-smoke` sub-script to `package.json` that runs the install smoke test (`node scripts/ci-install-smoke.mjs`) if it does not already exist

## 3. Document the pattern in README

- [ ] 3.1 Add (or verify) a "Matching CI" section in the README's test/build gate documentation explaining when to set `test_gate.command` (when CI runs steps beyond the auto-detected `test` script)
- [ ] 3.2 Include a `pipeline.yml` + `package.json` snippet showing the `npm run ci` pattern as the canonical example

## 4. Verify correctness

- [ ] 4.1 Run `npm run ci` locally on a clean tree and confirm it exits 0
- [ ] 4.2 Introduce a deliberate `core/` change without regenerating `plugin/`, run `npm run ci`, and confirm it exits non-zero with build-check output
- [ ] 4.3 Run `pnpm test` (or `npm test` at repo root) to confirm the full unit-test suite still passes
