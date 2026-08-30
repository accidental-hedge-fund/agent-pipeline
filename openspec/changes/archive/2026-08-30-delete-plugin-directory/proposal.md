## Why

After #1048, leftover `plugin/` (generated SKILL overlay, marketplace bridge, support scripts) still lives in the repo and still attracts edits. The product path is `install --host claude` → CLI plus short SKILL under `~/.claude/skills/pipeline/`. Delete the directory on the same ship as #1048. Do not wait for marketplace dogfood.

## What Changes

- **Delete `plugin/`.** `git rm -r plugin/` (or equivalent). No marketplace stub directory remains.
- **Generators stop writing `plugin/`.** `scripts/build.mjs` and `scripts/install.mjs` SHALL NOT write a repository `plugin/` tree. `build.mjs --check` SHALL NOT require a plugin SKILL overlay.
- **No marketplace stub.** The catalog currently lists one plugin whose source is `./plugin/pipeline`. After delete, the repo SHALL NOT advertise that source. Do not retarget the catalog at `hosts/claude` or a replacement stub dir.
- **Claude path is CLI plus SKILL.** Operators run `install --host claude`. Dogfood is `pipeline doctor` and `pipeline status <N>` from the installed SKILL. It is **not** `/pipeline status`.
- **Golden rule and packaging docs match.** Product is CLI plus short SKILL. Docs SHALL NOT say “commit the plugin/ core mirror” or describe a remaining generated `plugin/` shell.
- **Migration note.** Anyone with `CLAUDE_PLUGIN_ROOT` still pointing at a leftover core copy SHALL run `install --host claude` (or pin).
- **BREAKING** for operators who still load the engine from a marketplace `plugin/` tree or `CLAUDE_PLUGIN_ROOT` core copy. Remediation is reinstall / pin, not a stub package.
- **Not this change:** MCP (#907, parked). Splitting `pipeline.ts` (#990). Short-SKILL rewrite (#1049, already shipped). Stage machine. Merge inside advance/loop.

## Acceptance criteria

- [ ] The committed tree has no `plugin/` directory (no files, no empty stub).
- [ ] `node scripts/build.mjs` exits 0 and does not create any path under `plugin/`.
- [ ] `scripts/install.mjs` does not write a repository-root `plugin/` tree.
- [ ] `node scripts/build.mjs --check` exits 0 when the four generated host SKILLs are fresh and `plugin/` is absent.
- [ ] `node scripts/build.mjs --check` exits non-zero when any of the four generated host SKILLs is stale.
- [ ] `.claude-plugin/marketplace.json` (if present) does not list a plugin whose source is under `plugin/`.
- [ ] Isolated `install --host claude` (temp config dir) leaves a launcher that dispatches `pipeline doctor` and `pipeline status <N>` as CLI verbs. Those verbs do not require a repo `plugin/` tree or `/pipeline status`.
- [ ] `AGENTS.md` and `CLAUDE.md` golden rule #1 name CLI plus short SKILL as the product and do not tell contributors to commit `plugin/`.
- [ ] `docs/packaging.md` presents install CLI plus short SKILL and does not describe a remaining generated `plugin/` shell.
- [ ] Packaging / install docs name the migration: if `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy, run `install --host claude` (or pin).
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `plugin-directory-retirement`: The repository SHALL NOT contain `plugin/`. Build and install SHALL NOT write that tree. `--check` SHALL NOT require it. Claude install remains `install --host claude`. CI dogfoods `pipeline doctor` / `pipeline status`. Docs carry the `CLAUDE_PLUGIN_ROOT` migration note. Recreating `plugin/` SHALL fail tests without a new issue.

### Modified Capabilities

- `cli-host-provision`: Retract “this change SHALL NOT delete `plugin/`”. Generator and check SHALL NOT write or require a plugin SKILL overlay or marketplace bridge under `plugin/`.
- `cli-product-packaging`: Retire the “until #1050” transitional `plugin/` shell clauses. Packaging docs describe CLI plus SKILL only.
- `core-mirror-sync`: Freshness after `core/` edits is the four generated host SKILLs. Do not stage or require a plugin SKILL overlay.
- `pre-commit-mirror-regen`: The hook SHALL NOT stage any `plugin/` path.
- `generated-short-host-skill`: `build.mjs` SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`.
- `launcher-bootstrap`: Remove the transitional plugin-shell resolver and marketplace-bridge launcher. Installed skill trees still stage `ensure-engines-node.mjs`.
- `release-sub-command`: Drop `plugin/` from release-managed paths and generator-owned outputs. Do not restore a plugin tree on abort or stage.
- `test-gate-ci-parity`: `build.mjs --check` in `npm run ci` SHALL fail on stale host SKILLs, not on absence of `plugin/`.
- `eval-fixture-contract`: Post-#1050 pins SHALL NOT require a plugin SKILL overlay or a marketplace catalog that sources `plugin/`. Broad `plugin/**` allowances stay rejected.
- `eval-fixture-preflight`: Resolve current generator outputs without a plugin SKILL overlay. Historical pins may still require exact historical `plugin/` paths when the pinned `build.mjs` generated them.
- `monitor-filter-guidance`: Compact filter contract lives on the four generated host SKILLs. Do not require a plugin SKILL overlay.
- `stage-inventory-ssot`: Regenerating host SKILLs SHALL NOT also write a plugin overlay.
- `merge-queue-release-when-complete`: Release-managed files SHALL NOT include `plugin/`.
- `generated-cli-reference`: `build.mjs --check` owns the four host SKILLs. It SHALL NOT require a plugin overlay or a `plugin/`-sourced catalog.

## Impact

- **Tree:** `git rm -r plugin/`. Root `package.json` `files` no longer lists `plugin`.
- **Generator:** `scripts/build.mjs` writes the four `hosts/<id>/SKILL.md` files. It does not mkdir, copy, or write under `plugin/`. It does not emit a catalog entry with source `./plugin/pipeline`.
- **Installer:** `scripts/install.mjs` keeps staging CLI plus SKILL into the managed host tree. It does not write a repo `plugin/` tree.
- **Hooks / CI:** `.githooks/pre-commit` stages exact host SKILL paths only. `npm run ci` / `build.mjs --check` / `scripts/ci-install-smoke.mjs` prove no repo `plugin/` and that temp `install --host claude` dispatches `doctor` / `status`.
- **Release:** `pipeline release` managed set is packages, ROADMAP, generated host SKILLs, and any remaining non-`plugin/` catalog path. It does not stage or restore `plugin/`.
- **Docs / agent rules:** `docs/packaging.md`, `docs/concepts.md`, `CONTEXT.md`, `AGENTS.md`, `CLAUDE.md`, `openspec/project.md`, README Development. Golden rule stays CLI plus SKILL. Migration note for leftover `CLAUDE_PLUGIN_ROOT` core copies.
- **Depends on:** #1048 (Claude host provisions CLI; no core copy; no `/pipeline:*` pack). Already on `main` in this worktree.
- **Same ship:** v1.40.0 / parent #1046. Same PR as #1048 is allowed; #1048 already merged, so this is the remaining delete PR.
- **Does not:** add MCP; split `pipeline.ts`; rewrite short SKILL prose; merge inside advance/loop; add `auto_merge`.
