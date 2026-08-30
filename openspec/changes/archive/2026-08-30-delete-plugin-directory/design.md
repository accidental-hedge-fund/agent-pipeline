## Context

See `proposal.md` for why. After #1048, `scripts/build.mjs` still writes a transitional `plugin/` SKILL overlay, a marketplace bridge launcher, support scripts, a plugin manifest, and `.claude-plugin/marketplace.json` with `source: "./plugin/pipeline"`. `install --host claude` already stages CLI plus SKILL under the managed Claude skill tree. `--check` still requires the plugin SKILL overlay and that catalog.

Class vs site (engine dogfood bar):

1. **Class:** leftover generated `plugin/` packaging surface after the CLI install path shipped.
2. **Shared law:** generator, installer, `--check`, pre-commit, release-managed paths, golden-rule/packaging docs, and CI install-smoke. A later change that recreates `plugin/` must fail tests.
3. **Next identical fault:** do not file a mole issue per leftover file. The tests in this change are the gate.

First holding rung: keep `scripts/build.mjs` as the sole writer of the four generated host SKILLs, and keep `install --host claude` as the Claude path. Do not add a second generator, a marketplace stub package, or a new install shape.

## Goals / Non-Goals

**Goals:**

- Remove the committed `plugin/` tree.
- Stop `build.mjs` and `install.mjs` from writing a repo `plugin/` tree.
- Shrink `--check` and pre-commit to the four generated host SKILLs.
- Stop advertising `./plugin/pipeline` in the marketplace catalog.
- Dogfood isolated `install --host claude` with `pipeline doctor` and `pipeline status <N>`.
- Document leftover `CLAUDE_PLUGIN_ROOT` core-copy migration.

**Non-Goals:**

- MCP (#907).
- Splitting `pipeline.ts` (#990).
- Rewriting short SKILL prose (#1049 already shipped).
- A replacement marketplace plugin whose source is `hosts/claude` or a stub dir.
- Changing operator-visible CLI verbs.
- Merge inside advance/loop.

## Decisions

### D1 — Delete the whole `plugin/` tree on this ship

`git rm -r plugin/` is the deliverable. Do not leave an empty directory, a SKILL-only shell, or a bridge launcher. Grill lock: same ship as #1048; do not wait a week of marketplace dogfood.

- Alternative: keep `plugin/` as a SKILL overlay until more marketplace dogfood. Rejected by grill lock.
- Alternative: delete files but leave `plugin/` as an empty stub. Rejected: still attracts edits.

### D2 — No marketplace stub

`.claude-plugin/marketplace.json` currently lists one plugin with `source: "./plugin/pipeline"`. After `plugin/` is gone, that listing is false. Retargeting the source to `hosts/claude` or a new stub dir is a marketplace stub. An empty `plugins: []` catalog is also a stub.

`scripts/build.mjs` SHALL stop writing a catalog entry whose source is under `plugin/`. If the catalog file’s only remaining purpose is that listing, stop generating it and delete `.claude-plugin/marketplace.json`. Root `package.json` `files` SHALL drop `plugin` and, when the catalog is gone, `.claude-plugin`.

- Alternative: keep the catalog pointing at the missing tree. False and broken. Rejected.
- Alternative: retarget `source` to `hosts/claude`. Marketplace stub. Rejected.

### D3 — Reuse `build.mjs`; shrink the write and check sets

Keep `scripts/build.mjs` as the sole writer and freshness checker for `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` via `renderHostSkill`. Remove `plugin/` mkdir/copy/write, the marketplace bridge renderer, and the `./plugin/pipeline` catalog object from `buildInto`. `--check` compares only the four host SKILL targets.

Do not invent a new packaging generator. Do not keep `SKILL_OVERLAY_REL` as a required output.

- Alternative: leave `--check` requiring the plugin overlay so CI fails until someone remembers to delete it. That restores a `plugin/` write. Rejected.

### D4 — Claude path stays `install --host claude`

Reuse the #1048 install tree: launcher, repository `core/`, Node resolver, SKILL overlay under the managed Claude skill (`~/.claude/skills/pipeline/` or `CLAUDE_CONFIG_DIR`). `scripts/install.mjs` SHALL NOT write a repository-root `plugin/` tree. Dogfood is the installed launcher’s `doctor` and `status <N>` verbs, not `/pipeline status`.

- Alternative: keep a repo `plugin/` so marketplace install still works. Dual-ship. Rejected.

### D5 — Class tests, not a path-local mole

Minimum tests that bite current leftover-shell behavior:

1. After `build.mjs` (or generate-into-temp), no `plugin/` path exists under the output root.
2. `--check` exits 0 when the four host SKILLs match and `plugin/` is absent.
3. `--check` exits non-zero when any of the four host SKILLs is stale.
4. Isolated `install --host claude` (temp `CLAUDE_CONFIG_DIR`) dispatches `doctor` and `status <N>` without a repo `plugin/` tree.
5. A generate run that would recreate `plugin/pipeline/skills/pipeline/SKILL.md` fails the test from (1).
6. Marketplace catalog, if still present, has no plugin source under `plugin/`.

Inject I/O in unit tests. Reuse existing generate-into-temp and `ci-install-smoke` / `install.test.mjs` patterns. Do not add a live GitHub or marketplace-install CI job.

### D6 — Release-managed paths drop `plugin/`

`pipeline release` currently treats `plugin/` and `.claude-plugin/` as release-managed. After this change, the managed set is `package.json`, `core/package.json`, `ROADMAP.md`, the four generated host SKILLs, and `.claude-plugin/` only if that catalog file still exists as a generated output. Abort restore and PR staging SHALL NOT recreate `plugin/`. The generator SHALL NOT treat retired `plugin/pipeline/commands/` or `plugin/pipeline/skills/pipeline/core/` as live outputs to clean, because `plugin/` is gone.

- Alternative: keep staging `plugin/` so abort restore can put it back. That reintroduces the tree. Rejected.

### D7 — Docs: CLI plus SKILL; migration note; no remaining shell

Update `docs/packaging.md`, `docs/concepts.md`, README Development, `CONTEXT.md` (glossary meaning of Plugin directory), `AGENTS.md`, `CLAUDE.md`, and `openspec/project.md`. Remove “until #1050” / “transitional plugin shell” as current packaging. State the migration: if `CLAUDE_PLUGIN_ROOT` still points at a leftover core copy, run `install --host claude` (or pin). Golden rule stays CLI plus SKILL. Never “commit the plugin/ core mirror.”

Eval fixtures and dirty-trust forbidden globs MAY keep exact `plugin/**` rejection as a reintroduction guard. They SHALL NOT treat a plugin SKILL overlay as a current generator output.

## Risks / Trade-offs

- **[Risk] Marketplace users keep loading a leftover `CLAUDE_PLUGIN_ROOT` core copy.** → Mitigation: packaging docs name `install --host claude` / pin. The #1048 bridge already failed closed without a managed install; this change removes the bridge instead of leaving a stub.
- **[Risk] Agents keep editing or regenerating `plugin/`.** → Mitigation: golden rule, `build.mjs` no longer writes it, and the generate-into-temp test fails if it returns.
- **[Risk] `--check` or pre-commit still lists the plugin SKILL path and CI goes red after delete.** → Mitigation: shrink write/check/stage sets in the same change as `git rm`.
- **[Risk] `pipeline release` abort restore recreates `plugin/` from HEAD after delete lands.** → Mitigation: drop `plugin/` from the managed set in the same change.
- **[Risk] Historical eval pins still need exact old `plugin/` outputs.** → Mitigation: keep pin-resolved historical exceptions; do not grant a broad current `plugin/**` allowance.

## Migration Plan

1. Land this change: delete `plugin/`, stop generating it, shrink `--check` / hook / release paths, update docs, tests, `npm run ci`.
2. Operators who still have a leftover marketplace or `CLAUDE_PLUGIN_ROOT` core copy run `install --host claude` (or pin).
3. No wait window. Same ship as #1048.

Rollback: revert the change. That restores `plugin/` and the catalog listing. Prefer forward: the CLI install path is already the product.

## Open Questions

None that block specs. Empty `.claude-plugin/` after catalog delete is removed with the catalog file. OpenCode native `/pipeline` is unchanged.
