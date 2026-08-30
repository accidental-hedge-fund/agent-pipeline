## 1. Tests that bite leftover plugin/ generation

- [ ] 1.1 Add a generate-into-temp (or equivalent injected) test that fails while `scripts/build.mjs` still writes `plugin/`: after generate, `plugin/` must not exist and `plugin/pipeline/skills/pipeline/SKILL.md` must not exist. Verify the test fails on current `build.mjs` before the generator change
- [ ] 1.2 Add a `--check` test: matching four host SKILLs with `plugin/` absent exits 0; a stale host SKILL exits non-zero. Verify the “absent plugin overlay still passes” case fails on current `--check` (it still requires the plugin SKILL)
- [ ] 1.3 Extend isolated `install --host claude` smoke (temp `CLAUDE_CONFIG_DIR`, reuse `scripts/ci-install-smoke.mjs` / `install.test.mjs`) so `doctor` and `status <N>` dispatch without a repo `plugin/` tree and without `/pipeline status`. Verify the smoke still covers those verbs when `plugin/` is missing

## 2. Generator and catalog: do not write plugin/

- [ ] 2.1 Stop `scripts/build.mjs` from mkdir/copy/write under `plugin/` (SKILL overlay, bridge launcher, material-filter copy, resolver copy, plugin manifest, retired-dir cleanup that recreates the tree). Verify task 1.1 now passes
- [ ] 2.2 Stop `scripts/build.mjs` from writing a marketplace catalog entry with source `./plugin/pipeline`. If `.claude-plugin/marketplace.json` exists only to list that plugin, stop generating it and delete the file. Verify no catalog listing sources `plugin/`
- [ ] 2.3 Change `--check` write/compare targets to the four generated host SKILLs only. Do not require a plugin SKILL overlay. Verify task 1.2 now passes
- [ ] 2.4 Remove `plugin` from root `package.json` `files`. If the marketplace catalog is gone, also remove `.claude-plugin`. Verify `package.json` `files` no longer lists `plugin`

## 3. Delete the committed plugin/ tree

- [ ] 3.1 `git rm -r plugin/` (or equivalent) so the committed tree has no `plugin/` directory. Verify `git ls-files plugin` is empty and no empty stub directory remains
- [ ] 3.2 Confirm `scripts/install.mjs` does not write a repository-root `plugin/` tree. Verify an isolated install still stages the managed Claude skill from `core/` plus host SKILL (task 1.3 still passes)

## 4. Hooks, release, and adjacent packaging paths

- [ ] 4.1 Update `.githooks/pre-commit` so it stages only the four exact host SKILL paths and never stages a `plugin/` path. Verify the isolated hook fixture stages those four paths and leaves a planted `plugin/` working-tree file unstaged
- [ ] 4.2 Drop `plugin/` from `pipeline release` managed/staging/restore paths. Do not restore or recreate `plugin/` on abort. Verify release-path tests no longer expect `plugin/` in the pathspec
- [ ] 4.3 Update merge-queue release-when-complete dry-run so it does not treat `plugin/` as a release-managed write. Verify dry-run tests do not require mutating `plugin/`

## 5. Docs and golden rule

- [ ] 5.1 Update `docs/packaging.md`, `docs/concepts.md`, README Development, `CONTEXT.md` Plugin directory glossary, `AGENTS.md`, `CLAUDE.md`, and `openspec/project.md`: product is CLI plus short SKILL; no remaining generated `plugin/` shell; `build.mjs --check` is host-SKILL freshness. Verify those files no longer describe a current `plugin/` overlay
- [ ] 5.2 Add the migration note: if `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy, run `install --host claude` or pin. Verify the sentence is searchable in packaging or install docs

## 6. Adjacent tests and eval accounting

- [ ] 6.1 Retarget tests that assert `plugin/pipeline/skills/pipeline/SKILL.md`, plugin-shell launchers, or marketplace `source: "./plugin/pipeline"` so they match the spec deltas. Keep historical eval-pin exceptions exact. Verify `cd core && npm test` and scripts tests are green without restoring `plugin/`
- [ ] 6.2 Keep broad `plugin/**` eval/preflight rejections as a reintroduction guard. Verify a fixture that lists `plugin/**` still fails preflight

## 7. Gate

- [ ] 7.1 Run `openspec validate delete-plugin-directory` and `npm run ci` from the repo root. Verify both are green. After any `core/` edit, run `node scripts/build.mjs` so `--check` is clean without recreating `plugin/`
