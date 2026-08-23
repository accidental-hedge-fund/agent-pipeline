## Context

See `proposal.md` for why. Today `scripts/build.mjs` copies `core/{scripts,profiles,package.json,package-lock.json}` into `plugin/pipeline/skills/pipeline/core/`, writes one `pipeline:<name>.md` per `OPERATION_SURFACE` entry, and `--check` diffs that whole tree. `scripts/install.mjs` restages the same core into `~/.claude/skills/pipeline` (and peers), then `installClaudeCommands` / `installCodexCommands` emit slash files and yaml agents. Claude already has a CLI provision path. The extra surfaces are the dual-ship.

Class vs site (engine dogfood bar):

1. **Class:** dual distribution of the engine (committed `plugin/` core copy + per-verb command wrappers).
2. **Shared law:** generator, installer, `--check`, and golden-rule text. A new host that copies `core/scripts` into `plugin/` or emits `/pipeline:*` files must fail tests.
3. **Next identical fault:** do not file a mole issue per host. The tests in this change are the gate.

#1047 is closed via PR #1084 (`CONTEXT.md` only). `docs/packaging.md` is absent on this branch. `AGENTS.md` / `CLAUDE.md` / `openspec/project.md` still require committing the `plugin/` core mirror. This design rewrites that golden rule because it would be false after this change. It does not author `docs/packaging.md`.

## Goals / Non-Goals

**Goals:**

- One CLI provision path for Claude, matching Codex/Grok: skill-tree launcher + `core/node_modules`.
- Generator and installer stop emitting per-verb command files.
- `--check` and pre-commit stop requiring a byte-identical `plugin/` core tree.
- Tests that fail if the copy or slash pack returns.
- Leftover `pipeline:*.md` uninstall cleanup so a migrated host is clean.

**Non-Goals:**

- `git rm plugin/` (#1050).
- Short SKILL rewrite (#1049).
- MCP (#907).
- Splitting `pipeline.ts` (#990).
- New global npm `bin` that is a different install shape than today’s skill-tree CLI.
- Changing OpenCode’s native `/pipeline` command file (not `/pipeline:*`).
- Stage machine or merge-in-advance.

## Decisions

### D1 — Claude CLI provision stays skill-tree staging

Keep `stageInto`: overlay + `core/` whitelist + launcher shim + `npm ci` in the skill dest. That is how Codex and Grok already get the engine.

- Alternative: a separate global `pipeline` on `PATH` only. Extra install shape. Not required. `#990` is not required.
- Alternative: Claude keeps using `${CLAUDE_PLUGIN_ROOT}` marketplace copy. That is dual-ship. Rejected.

### D2 — Stop generating command files; keep leftover uninstall

Set Claude `commandsKind` so install does not write `pipeline:*.md`. Stop Codex yaml agents from `OPERATION_SURFACE`. Keep `uninstallClaudeCommands` (or equivalent leftover sweep) so old `commands/pipeline:*.md` files go away.

- Alternative: leave generation, stop only the core copy. Still a command pack. Rejected by grill lock.
- Alternative: also drop OpenCode `commands/pipeline.md`. Out of scope. That file is not `/pipeline:*`.

### D3 — `--check` compares SKILL overlay and marketplace catalog only

Until #1050, `build.mjs` may still write pluginified `SKILL.md` and `.claude-plugin/marketplace.json`. It must not copy `CORE_ENTRIES` into `plugin/`. `--check` fails on SKILL/catalog drift only.

- Alternative: stop writing `plugin/` entirely in this change. That is #1050.
- Alternative: keep `--check` on leftover `plugin/core` so it stays in sync until delete. That restores dual-ship. Rejected.

`build.mjs` currently `rmSync(plugin/)` then rebuilds. After this change, a generate run may drop leftover `plugin/core` as a side effect. Allowed. Do not restore the copy. Do not take `git rm -r plugin/` as this change’s deliverable.

### D4 — Delete unused per-verb renderers

Remove (or stop exporting) `renderClaudeCommand` / `renderCodexCommand` so they cannot be reattached. Keep `OPERATION_SURFACE` as the catalog. Retarget tests that imported the renderers to: catalog presence, files not written, leftover uninstall.

- Alternative: leave dead renderers for #1049. Dead generators get reused. Rejected.

### D5 — Golden rule rewrite lives here

Update `CLAUDE.md`, `AGENTS.md`, and `openspec/project.md` so they say: product is CLI + SKILL; `--check` is SKILL/catalog freshness until #1050 deletes `plugin/`. Do not leave “always commit the `plugin/` core mirror.”

### D6 — Class tests, not a Claude-only mole

Minimum tests that bite current behavior:

1. After `build.mjs` (or a generate-into-temp equivalent), no `plugin/**/core/scripts/pipeline.ts`.
2. Isolated `install --host claude` writes no `commands/pipeline:*.md` and still runs the installed launcher `doctor` / `status` dispatch (not “command not found”).
3. Isolated `install --host codex` writes no `OPERATION_SURFACE` yaml agents.
4. `--check` passes without a plugin core tree when SKILL/catalog match; fails when SKILL/catalog are stale.
5. Uninstall still deletes leftover `pipeline:status.md` and keeps sibling files.

Inject I/O in unit tests. Install smoke may use a temp `CLAUDE_CONFIG_DIR` as today. Do not require live GitHub for the “slash file missing” proof.

## Risks / Trade-offs

- **[Risk] Agents keep typing `/pipeline:status` until #1049 shortens SKILL.** → Mitigation: this change stops writing the files. Uninstall removes leftovers. #1049 owns the essay. Do not expand this change into SKILL rewrite.
- **[Risk] Leftover `plugin/core` can drift until #1050.** → Mitigation: same ship. `--check` must not re-require the copy. Train with #1050.
- **[Risk] Marketplace users on `CLAUDE_PLUGIN_ROOT` keep a core copy.** → Mitigation: #1050 migration note. This change stops generating the copy. Operators reinstall via `install --host claude`.
- **[Risk] Tests and docs still mention `plugin/pipeline/commands/pipeline:loop.md`.** → Mitigation: deltas in `namespaced-command-surface` and `loop-skill-orchestration`. Implementation must update those tests or they stay red.
- **[Risk] `js-yaml` floor was also asserted on the plugin core lockfile.** → Mitigation: keep the floor on `core/`. Installed CLI tree copies `core/` at install time.

## Migration Plan

1. Land this change: generator/install/check/tests/golden rule.
2. Operators run `install --host claude` (or `update`). Leftover slash files go away on uninstall/reinstall; uninstall also sweeps `pipeline:*.md` without a reinstall of commands.
3. Same ship: #1050 deletes `plugin/`.
4. Parallel: #1049 short SKILL.

Rollback: revert the change. Old generator copies core and emits slash files again. That is the rejected dual-ship. Prefer forward with #1050.

## Open Questions

None that block specs. OpenCode `/pipeline` stays. Short SKILL text is #1049. `docs/packaging.md` absence is leftover from #1047 and is not authored here.
