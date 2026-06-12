## 1. Pre-commit hook script

- [x] 1.1 Create `.githooks/pre-commit`: detect staged `core/` or `hosts/claude/` paths via `git diff --cached --name-only`, exit 0 early on no match, run `node scripts/build.mjs`, then `git add plugin/ .claude-plugin/marketplace.json`; exit non-zero if `build.mjs` fails.
- [x] 1.2 Make `.githooks/pre-commit` executable (`chmod +x`).

## 2. Setup script

- [x] 2.1 Create `scripts/setup-hooks.mjs`: run `git config --local core.hooksPath .githooks` and print a confirmation message.
- [x] 2.2 Add `"setup-hooks": "node scripts/setup-hooks.mjs"` to the `scripts` section of `package.json`.

## 3. Documentation

- [x] 3.1 Add a contributor setup note to `README.md` referencing `npm run setup-hooks`.

## 4. Tests

- [x] 4.1 Add a unit test (shell or Node) that verifies the hook's path-detection logic: a staged `core/` path triggers regeneration; a docs-only staged path does not.
- [x] 4.2 Verify that the hook never stages paths other than `plugin/` and `.claude-plugin/marketplace.json`.

## 5. Mirror + CI

- [x] 5.1 Run `node scripts/build.mjs` and confirm `plugin/` is up to date.
- [x] 5.2 Run `npm run ci` from repo root — all checks green.
