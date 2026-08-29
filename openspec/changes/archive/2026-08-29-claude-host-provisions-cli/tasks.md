## 1. Tests that bite current dual-ship

- [x] 1.1 Add a generate-into-temp (or equivalent injected) test that fails while `scripts/build.mjs` still copies `core/scripts` into `plugin/`: after generate, `plugin/**/core/scripts/pipeline.ts` must not exist. Verify the test fails on current `build.mjs` before the generator change
- [x] 1.2 Add an isolated `install --host claude` test (temp `CLAUDE_CONFIG_DIR`, reuse `scripts/install.test.mjs` patterns) that fails while install still writes `commands/pipeline:*.md`. Verify no `pipeline:*.md` after install, and that the test fails on current `installClaudeCommands`
- [x] 1.3 Add an isolated `install --host codex` test that fails while install still writes `OPERATION_SURFACE` yaml agents (`pipeline-<name>.yaml`). Verify the test fails on current `installCodexCommands`
- [x] 1.4 Add a `--check` test: matching SKILL overlay + marketplace catalog with no plugin core tree exits 0; stale SKILL or catalog exits non-zero. Verify the “no core tree still passes” case fails on current `--check` (it still requires the core copy)

## 2. Generator: no core copy, no slash pack

- [x] 2.1 Stop `scripts/build.mjs` from copying `CORE_ENTRIES` / `core/scripts` into `plugin/`. Verify task 1.1 now passes
- [x] 2.2 Stop `scripts/build.mjs` from writing `plugin/pipeline/commands/pipeline:<verb>.md`. Keep `OPERATION_SURFACE` as catalog only. Verify generate no longer creates that tree
- [x] 2.3 Change `--check` to SKILL overlay + marketplace catalog freshness only. Do not require a byte-identical `plugin/` core tree. Verify task 1.4 now passes
- [x] 2.4 Delete or stop exporting `renderClaudeCommand` and `renderCodexCommand` so they cannot be reattached. Retarget any test that imported them. Verify no remaining production caller writes per-verb command files from `OPERATION_SURFACE`

## 3. Installer: CLI provision, no command pack

- [x] 3.1 Stop Claude install from writing `pipeline:*.md` (Claude profile must not require `commandsKind` `claude-slash` as a product pack). Keep skill-tree CLI staging (launcher + repository `core/` + current-main Node resolver), best-effort install-time `npm ci`, and fail-closed first-run retry. Verify task 1.2 now passes
- [x] 3.2 Stop Codex install from writing `pipeline-<name>.yaml` agents from `OPERATION_SURFACE`. Verify task 1.3 now passes
- [x] 3.3 Keep leftover `pipeline:*.md` uninstall sweep (including orphan commands when the skill tree is already gone, dry-run no-delete, preserve sibling files). Verify existing uninstall tests still pass and still remove a planted `pipeline:status.md`
- [x] 3.4 Extend isolated Claude install smoke so the installed launcher retains `scripts/ensure-engines-node.mjs` and dispatches `doctor` and `status <N>` without a slash-command tree and without `plugin/**/core/scripts/pipeline.ts`. Verify `ci-install-smoke` (or the install test) covers that dispatch, not only `--help`
- [ ] 3.5 Force install-time `npm ci` failure or missing `npm`. Verify install exits 0 with launcher/core/SKILL plus a named warning and leaves dependencies retryable even if the failed command created partial `node_modules`; then restore working `npm` and prove the launcher's first non-version retry installs dependencies and dispatches the original argv. Verify a failed retry exits non-zero with the manual command and installed `core/` path, then remains retryable
- [ ] 3.6 Correct the host-SKILL setup sentence from automatic `npm install` to the actual best-effort install-time `npm ci` plus fail-closed first-run retry contract. Keep the broad short-SKILL rewrite in downstream #1049

## 4. Hooks, golden rule, and adjacent tests

- [x] 4.1 Update `.githooks/pre-commit` so it does not stage a `plugin/` core copy as required output. It may still run `build.mjs` and stage SKILL/catalog until #1050. Verify a core-only staged commit does not reintroduce `plugin/**/core/scripts/pipeline.ts`
- [x] 4.2 Reconcile with completed #1047 / PR #1304: preserve its `docs/packaging.md` and CLI-as-product golden-rule baseline in `CLAUDE.md`, `AGENTS.md`, and `openspec/project.md`; finalize `--check` as SKILL/catalog freshness and never restore “always commit the `plugin/` core mirror.” Verify those files no longer require a core copy
- [x] 4.3 Update tests and docs that assert `plugin/pipeline/commands/pipeline:loop.md`, `renderClaudeCommand` fast-template text, or `plugin/…/core/package-lock.json` advisory copy so they match the spec deltas. Verify `cd core && npm test` and `node --test` on `scripts/install.test.mjs` are green
- [x] 4.4 Do not `git rm -r plugin/` in this change. Verify the diff does not take whole-tree `plugin/` delete as its deliverable (#1050)
- [ ] 4.5 Reconcile #1047's temporary command/core-mirror bridges and every adjacent mirror-dependent living spec, including `docs/concepts.md`; record exact archive deltas and pass OpenSpec validation

## 5. Gate

- [ ] 5.1 After tasks 3.5, 3.6, and 4.5 are complete, run OpenSpec validation and `npm run ci` from the repo root. Verify both are green. After any `core/` edit, run `node scripts/build.mjs` so `--check` is clean without restoring a core copy
