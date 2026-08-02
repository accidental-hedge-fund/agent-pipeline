## 1. Claude command skill-path embedding

- [x] 1.1 In `installClaudeCommands`, pass the resolved skill directory for the given Claude base (`<claudeBase>/skills/pipeline`) into `renderClaudeCommand` instead of the hardcoded `"~/.claude/skills/pipeline"` string
- [x] 1.2 Confirm dry-run still writes nothing under `commands/` and that default (unset `CLAUDE_CONFIG_DIR`) installs still point at the default Claude skill location
- [x] 1.3 Add unit coverage in `scripts/install.test.mjs` that installs under a temp `CLAUDE_CONFIG_DIR` and asserts every `pipeline:*.md` invoke path references that config-dir skill path (and not `~/.claude/skills/pipeline`)

## 2. Claude uninstall command cleanup

- [x] 2.1 Extend `uninstallHost` for Claude (or a helper it calls) to remove `pipeline:*.md` under the resolved Claude base’s `commands/` directory when uninstalling
- [x] 2.2 Ensure uninstall does not delete non-`pipeline:` command files; dry-run logs intended removals without deleting
- [x] 2.3 Add unit coverage: install then uninstall under a temp `CLAUDE_CONFIG_DIR` leaves no skill dir and no `pipeline:*.md` files, while a sibling non-pipeline command file remains

## 3. Codex shadow detection parity

- [x] 3.1 Generalize the install-loop shadow gate from `h === "claude"` to tree-mode hosts (Claude + Codex), using each host’s skills dest and a host-appropriate backup base (Claude: `claudeBase()`; Codex: parent of resolved skills dir / `CODEX_HOME`)
- [x] 3.2 Reuse existing `detectPersonalSkill`, relocation helpers, and marker semantics; do not introduce a second marker design
- [x] 3.3 Add unit coverage for Codex: unmanaged personal skill → shadowing true; managed marker → false; TTY decline skips without overwrite; non-TTY auto-relocates; `CODEX_HOME` override is honored for dest/backup base

## 4. Verification

- [x] 4.1 Run `scripts/install.test.mjs` (or the project’s scripts test entry) and fix failures
- [x] 4.2 Run `npm run ci` from the repo root and ensure green (including install smoke)
- [x] 4.3 Confirm no application changes outside installer/test surface required by this change; leave dual-SKILL.md parity generator out of scope
