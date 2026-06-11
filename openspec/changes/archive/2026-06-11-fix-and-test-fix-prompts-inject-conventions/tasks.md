## 1. Write regression tests first (red)

- [x] 1.1 In `core/test/prompts.test.ts` (or the adjacent prompt-builder test file), add a test that calls `buildFixPrompt` with a fake config containing known conventions content and asserts the returned string includes that content — confirm the test fails before the fix.
- [x] 1.2 Add a matching test for `buildTestFixPrompt` with the same shape — confirm it also fails before the fix.

## 2. Inject conventions into fix and test-fix prompts

- [x] 2.1 Add `{{conventions}}` placeholder to `core/scripts/prompts/fix.md` in the same structural position as `implementing.md` (before the task description block).
- [x] 2.2 Add `{{conventions}}` placeholder to `core/scripts/prompts/test_fix.md` in the same position.
- [x] 2.3 In `core/scripts/prompts/index.ts`, add `conventions: readConventions(cfg)` to the interpolation map inside `buildFixPrompt`.
- [x] 2.4 In `core/scripts/prompts/index.ts`, add `conventions: readConventions(cfg)` to the interpolation map inside `buildTestFixPrompt`.
- [x] 2.5 Confirm both regression tests from step 1 now pass.

## 3. Fix cross-host conventions filename references

- [x] 3.1 In `core/scripts/prompts/implementing.md` line 15, change "Read CLAUDE.md" to name both `CLAUDE.md` / `AGENTS.md` (or use a host-neutral phrase like "Read the conventions file (CLAUDE.md or AGENTS.md)").
- [x] 3.2 In `hosts/codex/SKILL.md`, locate the per-repo-config example that references `CLAUDE.md` and change it to `AGENTS.md` (or remove the filename and let the reader infer from context).

## 4. Verify and regenerate the plugin mirror

- [x] 4.1 Run `npm run ci` from the repo root; confirm all tests pass.
- [x] 4.2 Run `node scripts/build.mjs` to regenerate `plugin/` and then `node scripts/build.mjs --check` to confirm the mirror is in sync.
- [ ] 4.3 Commit all changes (`core/`, `hosts/codex/SKILL.md`, `plugin/`) with message referencing #108.
