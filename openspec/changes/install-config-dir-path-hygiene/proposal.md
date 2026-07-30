## Why

Three packaging footguns from the install audit leave non-default and Codex installs broken or unsafe: Claude `/pipeline:*` command files hardcode `~/.claude/skills/pipeline` even when the skill lands under `$CLAUDE_CONFIG_DIR`; uninstall removes only the skill directory and orphans `pipeline:*.md` command files; and personal-skill shadow/relocation protection runs for Claude only, so a Codex personal skill without the managed marker is silently overwritten.

## What Changes

- Claude host install SHALL pass the **resolved skill directory path** into `renderClaudeCommand` when writing `pipeline:<op>.md` under `<claudeBase>/commands/`, so Invoke lines track `$CLAUDE_CONFIG_DIR` (and the default home path) instead of a hardcoded `~/.claude/skills/pipeline`.
- Claude host uninstall SHALL remove the `pipeline:<op>.md` command files the installer wrote under `<claudeBase>/commands/`, not only the skill tree at `<skillsDir>/pipeline`.
- Install-time personal-skill shadow detection and relocation SHALL run for **Codex** with the same managed-marker semantics as Claude (detect unmanaged `…/skills/pipeline`, offer/auto-relocate outside the skills scan path, skip host install on TTY decline), honoring `CODEX_HOME` / Codex base resolution.
- Unit/integration tests SHALL cover config-dir command path emission, uninstall command cleanup, and Codex shadow detection/relocation.
- Full `npm run ci` remains green (including install tests).

## Acceptance criteria

- [ ] With `CLAUDE_CONFIG_DIR=/custom/dir`, a Claude install writes each `pipeline:<op>.md` such that the skill path embedded in the command body is under `/custom/dir/skills/pipeline` (not `~/.claude/skills/pipeline`).
- [ ] With `CLAUDE_CONFIG_DIR` unset, Claude install still writes command files under `~/.claude/commands/` that invoke the skill under `~/.claude/skills/pipeline` (or the absolute equivalent of that path).
- [ ] After a Claude install that wrote `pipeline:*.md` command files, `uninstall --host claude` removes those command files from `<claudeBase>/commands/` and removes the skill directory.
- [ ] Uninstall does not delete non-pipeline command files in `<claudeBase>/commands/`.
- [ ] Dry-run uninstall reports that it would remove the Claude command files and does not delete them.
- [ ] When an unmanaged Codex personal skill exists at the Codex install target (no `.pipeline-installer-managed` marker), install emits a shadow warning and offers/auto-relocates equivalently to Claude before overwriting.
- [ ] When a Codex skill dir has the managed marker, install overwrites without a shadow warning.
- [ ] Codex shadow paths honor `CODEX_HOME` (and existing Codex base resolution); no hardcoded `~/.codex` when the env override is set.
- [ ] Regression tests cover config-dir command paths, uninstall cleanup, and Codex shadow detection; `npm run ci` is green.

## Capabilities

### New Capabilities

- `installer-uninstall-cleanup`: Claude uninstall removes installer-written `pipeline:<op>.md` command files in addition to the skill directory; dry-run and non-pipeline file safety.

### Modified Capabilities

- `namespaced-command-surface`: Install-time Claude command rendering SHALL embed the resolved skill path for the active `CLAUDE_CONFIG_DIR` / default base, not a hardcoded `~/.claude/skills/pipeline`.
- `installer-shadow-detection`: Shadow detection, marker semantics, and relocation SHALL apply to Codex install targets with host-appropriate base paths (`CODEX_HOME` / Codex skills base), not Claude-only.

## Impact

- **`scripts/install.mjs`**: `installClaudeCommands` skillPath argument; `uninstallHost` Claude command cleanup; install loop shadow check for every host (not only `h === "claude"`); Codex backup base helper.
- **`scripts/install.test.mjs`**: new/extended coverage for command path, uninstall, Codex shadow.
- **Possibly `scripts/ci-install-smoke.mjs`**: assert command body path under isolated `CLAUDE_CONFIG_DIR` if that is the cheapest end-to-end gate.
- **Plugin mirror / `build.mjs` plugin command generation**: out of scope for path fix (plugin path is rewritten via `pluginifyCommandFile`); personal install path is the bug.
- **No runtime engine (`core/`) behavior change**; no new dependencies; not **BREAKING** for default `~/.claude` users beyond correct uninstall cleanup.
- Related closed work: #450 / #567 install lock (unchanged); dual-SKILL.md content parity generator remains out of scope.
