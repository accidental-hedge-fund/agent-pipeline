## Context

See `proposal.md` for why. Today `scripts/build.mjs` copies `core/{scripts,profiles,package.json,package-lock.json}` into `plugin/pipeline/skills/pipeline/core/`, writes one `pipeline:<name>.md` per `OPERATION_SURFACE` entry, and `--check` diffs that whole tree. `scripts/install.mjs` restages the same core into `~/.claude/skills/pipeline` (and peers), then `installClaudeCommands` / `installCodexCommands` emit slash files and yaml agents. Claude already has a CLI provision path. The extra surfaces are the dual-ship.

Class vs site (engine dogfood bar):

1. **Class:** dual distribution of the engine (committed `plugin/` core copy + per-verb command wrappers).
2. **Shared law:** generator, installer, `--check`, and golden-rule text. A new host that copies `core/scripts` into `plugin/` or emits `/pipeline:*` files must fail tests.
3. **Next identical fault:** do not file a mole issue per host. The tests in this change are the gate.

#1047 is complete via PR #1304 at merge commit `0494825bff716f08db9e5ac8869a30e20d338970`. It added `docs/packaging.md` and transitional packaging requirements. This design reconciles those contracts to the post-core-mirror state and rewrites the remaining golden-rule text because the old mirror rule is false after this change. #1049 starts only after `main` contains both that merge and reconciled #1048 / PR #1222.

## Goals / Non-Goals

**Goals:**

- One CLI provision path for Claude, matching Codex/Grok: staged skill-tree launcher + repository core tree + current-main Node resolver, with fail-soft dependency prewarm and fail-closed, retryable first-run provisioning.
- Generator and installer stop emitting per-verb command files.
- `--check` and pre-commit stop requiring a byte-identical `plugin/` core tree.
- Tests that fail if the copy or slash pack returns.
- Leftover `pipeline:*.md` uninstall cleanup so a migrated host is clean.

**Non-Goals:**

- `git rm plugin/` (#1050).
- Broad short-SKILL rewrite (#1049, follow-on after this reconciliation).
- MCP (#907).
- Splitting `pipeline.ts` (#990).
- New global npm `bin` that is a different install shape than today’s skill-tree CLI.
- Changing OpenCode’s native `/pipeline` command file (not `/pipeline:*`).
- Stage machine or merge-in-advance.

## Decisions

### D1 — Claude CLI provision keeps skill-tree staging and fail-soft dependency prewarm

Keep `stageInto`: build the overlay + `core/` whitelist + launcher shim + material filter + current-main `ensure-engines-node.mjs` resolver in the sibling staging directory, then move that complete tree into the managed skill destination. After the tree move, attempt `npm ci --omit=dev --no-audit --no-fund` in the installed `core/` as a best-effort dependency prewarm. If `npm` is absent or the prewarm exits non-zero, emit a named warning and keep the completed install. Per the existing #153 contract, dependency prewarm is not an installation completion barrier.

The launcher keeps `--version` dependency-free. For the first non-version invocation whose dependencies are not ready, it resolves an engines-compliant Node, retries the same `npm ci`, and dispatches the original argv only after success. A failed prewarm or retry must remove or invalidate any partial dependency state so the next invocation remains retryable. A failed retry exits non-zero and names the manual `npm ci` command and installed `core/` path. That is how the managed Claude/Codex skill-tree install remains fail-soft at installation and fail-closed at execution.

All non-dry-run mutating installer commands (`install`, `update`, and `uninstall`) share a process-owned installer-operation lock held from before destination inspection through tree mutation and any prewarm. This closes the two-fresh-installer case that the existing update lock cannot see before either destination exists and prevents uninstall from deleting a core beneath installer-owned npm. The operation lock is never reclaimed solely because its parent PID died: `spawnSync`'s npm child can survive that parent. It is separate from the launcher-visible update lock, so a launcher that observes a freshly published incomplete core waits on its core-local dependency owner. Replacement and removal also refuse any extant core-local dependency lock, covering a launcher parent that died while npm survived.

- Alternative: a separate global `pipeline` on `PATH` only. Extra install shape. Not required. `#990` is not required.
- Alternative: Claude keeps using `${CLAUDE_PLUGIN_ROOT}` marketplace copy. That is dual-ship. Rejected.
- Alternative: make install-time `npm ci` a hard completion barrier. Rejected because it conflicts with #153's `npx … install` fail-soft contract for transient registry, offline, cache-permission, and engine-strict failures.

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
6. A stubbed failing install-time `npm ci` warns, exits 0, preserves the staged launcher/core/SKILL tree, and leaves dependencies retryable.
7. A first non-version invocation retries when dependencies are absent or a prior attempt left partial state; success dispatches the original verb, while failure exits non-zero with manual remediation and remains retryable.
8. Current-main `scripts/ensure-engines-node.mjs` stays next to the installed launcher and runs before TypeScript-loading routes.
9. Two concurrent fresh installers produce one publisher and one dependency prewarm owner; the loser fails before tree mutation, while the existing installer-plus-launcher test still waits and dispatches.
10. Uninstall racing live installer prewarm, or encountering an abandoned core-local dependency owner, fails before deleting the npm working tree and names exact recovery.

Inject I/O in unit tests. Install smoke may use a temp `CLAUDE_CONFIG_DIR` as today. Do not require live GitHub for the “slash file missing” proof.

### D7 — Archive against #1047-complete main

#1048 retires #1047's temporary namespaced-command and core-mirror bridges, updates the `cli-product-packaging` transition clauses, and retargets adjacent mirror-dependent living specs to the exact remaining SKILL/catalog/CLI artifacts. The archived deltas SHALL record those reconciliations against the #1047-complete `main`; no broad `plugin/**` exception survives.

## Risks / Trade-offs

- **[Risk] Agents keep typing `/pipeline:status` until #1049 shortens SKILL.** → Mitigation: this change stops writing the files and removes obsolete menu claims needed for truthful packaging. Uninstall removes leftovers. #1049 owns the broad short-SKILL rewrite after this change merges.
- **[Risk] Leftover `plugin/core` can drift until #1050.** → Mitigation: same ship. `--check` must not re-require the copy. Train with #1050.
- **[Risk] Marketplace users on `CLAUDE_PLUGIN_ROOT` keep a core copy.** → Mitigation: #1050 migration note. This change stops generating the copy. Operators reinstall via `install --host claude`.
- **[Risk] Tests and docs still mention `plugin/pipeline/commands/pipeline:loop.md`.** → Mitigation: deltas in `namespaced-command-surface` and `loop-skill-orchestration`. Implementation must update those tests or they stay red.
- **[Risk] `js-yaml` floor was also asserted on the plugin core lockfile.** → Mitigation: keep the floor on `core/`. Installed CLI tree copies `core/` at install time.
- **[Risk] Install-time `npm ci` can fail because npm is missing or a package registry is temporarily unavailable.** → Mitigation: installation emits a named warning and preserves the launcher's bounded first-run self-heal. The first invocation may be slower; if self-heal also fails, the launcher fails closed with remediation instead of dispatching an unprovisioned engine.
- **[Risk] Failed `npm ci` leaves a partial `node_modules` directory that suppresses first-run retry.** → Mitigation: classify dependencies as ready only after successful provisioning; failed prewarm/retry removes or invalidates partial state, and a regression test proves the next invocation retries.

## Migration Plan

1. Land this change: generator/install/check/tests/golden rule.
2. Operators run `install --host claude` (or `update`). Leftover slash files go away on uninstall/reinstall; uninstall also sweeps `pipeline:*.md` without a reinstall of commands.
3. Same ship: #1050 deletes `plugin/`.
4. Follow-on after #1047 and #1048 are both on `main`: #1049 short SKILL.

Rollback: revert the change. Old generator copies core and emits slash files again. That is the rejected dual-ship. Prefer forward with #1050.

## Open Questions

None that block specs. OpenCode `/pipeline` stays. The broad short-SKILL rewrite remains #1049 after this change merges.
