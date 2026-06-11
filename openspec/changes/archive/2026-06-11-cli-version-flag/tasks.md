## 1. Implementation

- [x] 1.1 In `core/scripts/pipeline.ts`, use `createRequire(import.meta.url)` to read `version` from `../package.json` (i.e. `core/package.json` relative to the script file; mirror-safe — `build.mjs` copies `package.json` beside `scripts/`)
- [x] 1.2 Call `.version(version, '-V, --version', 'print version and exit')` on the root commander `program`, before any `.argument()` or `.option()` registrations

## 2. Tests

- [x] 2.1 Add a unit test in `core/test/` that imports the resolved version string and asserts it equals the `version` field of `core/package.json` (confirms single-source-of-truth, covers Requirement: Version sourced from package.json)
- [x] 2.2 Verify the test fails without the fix (prove it bites), then confirm it passes with the implementation in place

## 3. Mirror & CI

- [x] 3.1 Regenerate `plugin/` mirror: `node scripts/build.mjs` from repo root
- [x] 3.2 Run `npm run ci` from repo root — all checks must pass (core tests, mirror sync, install smoke)
