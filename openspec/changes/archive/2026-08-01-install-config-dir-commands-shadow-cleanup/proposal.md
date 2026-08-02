## Why

Three packaging footguns from the install audit leave non-default and dual-host installs broken or destructive: Claude `/pipeline:*` command files hardcode `~/.claude/skills/pipeline` even when the skill lives under `CLAUDE_CONFIG_DIR`; uninstall removes only the skill tree and orphans `commands/pipeline:*.md`; and personal-skill shadow/relocation protection runs only for Claude, so a Codex personal skill without the managed marker can be silently overwritten.

## What Changes

- When installing Claude command files, pass the **actual resolved skill directory path** (honoring `CLAUDE_CONFIG_DIR`) into command rendering so Invoke lines point at the installed skill, not a hardcoded `~/.claude/skills/pipeline`.
- When uninstalling the Claude host, remove the **installer-written** `pipeline:*.md` command files under the resolved Claude config `commands/` directory (same base as install), not only the skill tree.
- Apply personal-skill **shadow detection and relocation** to the Codex host with the same marker semantics and interactive/non-interactive behavior already used for Claude (paths under Codex skills dir / `CODEX_HOME`).
- Add unit/regression tests for config-dir command path content, Claude uninstall command cleanup, and Codex shadow detection/relocation.
- Keep plugin-marketplace / default-home path behavior correct when env overrides are unset.

## Acceptance criteria

- [ ] With `CLAUDE_CONFIG_DIR` set to a non-default directory, after `install --host claude`, every generated `commands/pipeline:*.md` file under that config dir references the skill path under that config dir (not a bare `~/.claude/skills/pipeline` path).
- [ ] With `CLAUDE_CONFIG_DIR` unset, install still writes command files whose skill path resolves to the default Claude skill location (`~/.claude/skills/pipeline` or equivalent absolute form of the same location).
- [ ] After `install --host claude` then `uninstall --host claude`, the skill directory is gone **and** no installer-written `pipeline:*.md` files remain under that Claude config’s `commands/` directory.
- [ ] Uninstall does not delete non-pipeline command files under `commands/` (only namespaced `pipeline:*.md` written by install).
- [ ] When a personal (no `.pipeline-installer-managed` marker) skill exists at the Codex skills path, `install --host codex` (or `--host all` including codex) offers relocation / auto-relocates / skips equivalently to Claude — it does not silently overwrite the personal tree.
- [ ] When a Codex install already has the managed marker, install proceeds with normal overwrite and does not emit a personal-shadow relocation offer.
- [ ] Unit tests cover: (1) config-dir command path content, (2) uninstall command cleanup, (3) Codex shadow detect + relocation/skip paths.
- [ ] `npm run ci` passes (including install tests / install smoke).

## Capabilities

### New Capabilities

- `installer-command-lifecycle`: Correct skill-path embedding in Claude `/pipeline:*` command files under `CLAUDE_CONFIG_DIR`, and uninstall cleanup of those command files alongside the skill tree.

### Modified Capabilities

- `installer-shadow-detection`: Extend personal-skill detection, marker semantics, and relocation/skip behavior from Claude-only to Codex (and any tree-mode host that shares the same skill dest + marker contract), so unmanaged personal Codex installs are not silently overwritten.

## Impact

- **Installer:** `scripts/install.mjs` (`installClaudeCommands`, `uninstallHost`, install-loop shadow gate currently gated on `h === "claude"`).
- **Command rendering:** `scripts/build.mjs` `renderClaudeCommand` already accepts a `skillPath`; install must pass the real path. Plugin/build-time generation for default `~/.claude` may stay as-is unless it shares the same install call path.
- **Tests:** `scripts/install.test.mjs` (and any related install smoke assertions).
- **Out of scope:** Full dual-host SKILL.md content parity generator; changing Codex agent YAML layout under the skill tree; auto-merge; review rigor demotion; related closed install-lock work (#450/#567).
