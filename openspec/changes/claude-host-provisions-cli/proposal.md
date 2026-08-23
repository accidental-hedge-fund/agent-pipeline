## Why

`scripts/build.mjs` copies `core/` into `plugin/…/core/` (~299 files) and emits one `/pipeline:<verb>.md` file per `OPERATION_SURFACE` entry. CI `--check` fails on a byte-identical core-tree drift. Claude slash-command files are six-line argv wrappers around that copy. The product is the `pipeline` CLI. Claude must get that CLI the same way Codex and Grok do: `install --host claude` provisions the launcher plus `core/node_modules`. Hosts are short SKILL shims that exec `pipeline <verb>`. They are not a second engine and not a marketplace command pack.

This is v1.40.0 packaging class law (#1046 train: #1047 → {#1048 + #1050 same ship, #1049 parallel}). It is not a path-local mole. The next host that vendors `core/scripts` into `plugin/` or emits `/pipeline:*` files must fail tests without a new issue.

## What Changes

- **CLI install for Claude.** `install --host claude` SHALL provision the pipeline CLI (launcher + `core/node_modules`) and install the host SKILL overlay. The SKILL SHALL tell the agent to exec `pipeline <verb>`. Short SKILL text is owned by #1049; this change points install at that SKILL (or the current overlay until #1049 lands).
- **No core copy in `plugin/`.** `scripts/build.mjs` SHALL NOT copy `core/scripts` (or any engine source under `core/`) into `plugin/`. **No dual-ship** of the core mirror.
- **No `/pipeline:*` command pack.** Build and install SHALL NOT generate Claude `pipeline:<verb>.md` files or Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`. `OPERATION_SURFACE` remains the verb catalog for docs and the SKILL table. It is not a reason to emit one file per verb.
- **No marketplace command pack.** The generator SHALL NOT emit a per-verb slash-command tree under `plugin/pipeline/commands/`.
- **`--check` is SKILL/catalog freshness.** `node scripts/build.mjs --check` SHALL assert generated SKILL overlay and marketplace catalog freshness only. It SHALL NOT require a byte-identical `plugin/` core tree.
- **Operator-visible CLI verbs unchanged.** `pipeline doctor`, `pipeline status`, `pipeline single`, and the rest of the CLI keyword surface keep their names, arguments, and behavior.
- **Leftover slash files.** Uninstall SHALL still remove leftover `pipeline:*.md` from a previous install so a migrated host is clean.
- **BREAKING** for operators who invoke `/pipeline:status` (and peers) as Claude slash commands, or `$pipeline:status` Codex yaml agents, as the product path. The product path is `pipeline <verb>`.
- **Not this change:** `git rm plugin/` (#1050, same ship). MCP (#907, parked). Splitting `pipeline.ts` (#990 → v1.40.2). Stage machine. Short SKILL rewrite (#1049, parallel).

## Acceptance criteria

- [ ] After `node scripts/build.mjs`, the generator has not written `plugin/**/core/scripts/pipeline.ts` (or any `core/scripts` engine source under `plugin/`).
- [ ] `node scripts/build.mjs --check` exits 0 without a byte-identical `plugin/` core tree when generated SKILL overlay and marketplace catalog match.
- [ ] `node scripts/build.mjs --check` exits non-zero when the generated SKILL overlay or marketplace catalog is stale.
- [ ] `install --host claude` (not dry-run) does not write `pipeline:*.md` under the resolved Claude `commands/` directory.
- [ ] `install --host claude` writes a launcher and provisions `core/node_modules` under the Claude skill install (same CLI shape as Codex/Grok).
- [ ] After that install, the installed launcher accepts `doctor` and `status <N>` as CLI verbs. Those verbs do not require a generated slash-command tree or `plugin/**/core/scripts/pipeline.ts`.
- [ ] Codex host install does not write `pipeline-<name>.yaml` command agents from `OPERATION_SURFACE`.
- [ ] `pipeline doctor`, `pipeline status`, and `pipeline single` still dispatch as CLI keywords with unchanged operator-visible contracts.
- [ ] `uninstall --host claude` still deletes leftover `pipeline:*.md` files and does not delete unrelated command files.
- [ ] Unit/smoke tests prove: no vendored `plugin/**/core/scripts/pipeline.ts` required for install; no generated slash-command tree required for install.
- [ ] This change does not `git rm -r plugin/` (that is #1050).
- [ ] `npm run ci` is green.

## Capabilities

### New Capabilities

- `cli-host-provision`: Claude install provisions the pipeline CLI (launcher + `core/node_modules`) and a SKILL that execs `pipeline <verb>`. Build and install do not vendor `core/scripts` into `plugin/` and do not emit a `/pipeline:*` or Codex yaml command pack. `OPERATION_SURFACE` stays a catalog. `#990` is not required.

### Modified Capabilities

- `namespaced-command-surface`: Retract generated per-verb host command files. Operators invoke `pipeline <verb>`. `OPERATION_SURFACE` is catalog only. Advance default and modifier flags stay as today.
- `installer-command-lifecycle`: Claude install SHALL NOT write `pipeline:*.md`. Uninstall SHALL still remove leftover `pipeline:*.md`. Dry-run still writes nothing.
- `core-mirror-sync`: Golden rule and `--check` SHALL require SKILL/catalog freshness, not a committed `plugin/` core copy.
- `pre-commit-mirror-regen`: The hook SHALL NOT regenerate or stage a `plugin/` core copy. It MAY still run `build.mjs` for SKILL/catalog until #1050.
- `test-gate-ci-parity`: `build.mjs --check` in `npm run ci` SHALL fail on stale SKILL/catalog, not on absence of a byte-identical `plugin/` core tree.
- `loop-skill-orchestration`: Loop long-running follow/notify law stays. It SHALL NOT depend on generated `plugin/pipeline/commands/pipeline:loop.md`.
- `dependency-advisory-hygiene`: The `js-yaml` floor SHALL be enforced on `core/` (and the installed CLI tree). It SHALL NOT require a `plugin/…/core/` lockfile copy.

## Impact

- **Generator:** `scripts/build.mjs` stops copying `CORE_ENTRIES` into `plugin/` and stops writing `plugin/pipeline/commands/pipeline:<name>.md`. `--check` compares SKILL overlay and `.claude-plugin/marketplace.json` (catalog), not a core tree.
- **Installer:** `scripts/install.mjs` stops `installClaudeCommands` / `installCodexCommands` emission from `OPERATION_SURFACE`. Claude `commandsKind` is not a slash-command pack. Staging of launcher + `core/` + `npm ci` in the skill install remains the CLI provision path.
- **Hooks / CI:** `.githooks/pre-commit`, `npm run ci` / `build.mjs --check`, `scripts/ci-install-smoke.mjs`, and root `scripts/install.test.mjs` follow the new check and install contracts.
- **Docs / agent rules:** `CLAUDE.md`, `AGENTS.md`, and `openspec/project.md` golden rule #1 become CLI + SKILL. They no longer say “always commit the `plugin/` core mirror.”
- **Depends on:** #1047 (closed). Conflict: PR #1084 landed `CONTEXT.md` only. `docs/packaging.md` is absent on this branch. `AGENTS.md` / `CLAUDE.md` / `openspec/project.md` still require the core mirror. This change rewrites that golden rule. It does not author `docs/packaging.md`.
- **Same ship, not this change:** #1050 deletes `plugin/`. Leftover `plugin/` files after the generator stops copying core are #1050’s delete, unless a regenerate side effect drops them. This change MUST NOT restore the copy and MUST NOT claim `git rm plugin/` as its deliverable.
- **Parallel:** #1049 short SKILL. This install points at the host SKILL overlay; it does not rewrite the 80KB essays.
- **Does not:** add MCP; split `pipeline.ts`; change the stage machine; merge inside advance/loop; add `auto_merge`.
