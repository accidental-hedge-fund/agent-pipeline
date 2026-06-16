## 1. Fix `scaffoldDefaultConfig`

- [x] 1.1 In `core/scripts/config.ts`, add `if (fs.existsSync(configPath)) return { created: false };` as the first statement in `scaffoldDefaultConfig`, before `mkdirSync` and `writeFileSync`. Retain the `wx` flag on `writeFileSync` for TOCTOU protection.

## 2. Add regression test

- [x] 2.1 In `core/test/init.test.ts`, add a test named `"scaffoldDefaultConfig: does not overwrite an existing untracked .github/pipeline.yml (regression #176)"`. The test SHALL write a sentinel file directly to `path.join(repo, ".github", "pipeline.yml")` via `fs.writeFileSync` (simulating an untracked file), call `scaffoldDefaultConfig(repo)`, and assert `result.created === false` and that the file content equals the sentinel string.
- [x] 2.2 Verify the regression test bites without the fix: temporarily remove the `existsSync` guard, run the test, confirm it fails, then restore the guard.

## 3. Validate and ship

- [x] 3.1 Run `npm run ci` from the repo root and confirm all tests pass and the mirror is in sync.
- [x] 3.2 Regenerate the plugin mirror: `node scripts/build.mjs` and commit `plugin/` changes alongside `core/` changes in the same commit.
