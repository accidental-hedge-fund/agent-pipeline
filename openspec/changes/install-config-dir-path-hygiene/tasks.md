## 1. Claude command path at install

- [ ] 1.1 Change `installClaudeCommands` to pass the resolved absolute skill path (`join(claudeBaseDir, "skills", "pipeline")`) into `renderClaudeCommand` instead of the hardcoded `~/.claude/skills/pipeline` string
- [ ] 1.2 Confirm default (no `CLAUDE_CONFIG_DIR`) still writes under home `.claude/commands/` with a body path that resolves to that home skill dir

## 2. Claude uninstall command cleanup

- [ ] 2.1 Extend `uninstallHost("claude", …)` to remove each `<claudeBase>/commands/pipeline:<name>.md` for `OPERATION_SURFACE` (idempotent if missing)
- [ ] 2.2 Include command-file removal in dry-run messaging without deleting files
- [ ] 2.3 Ensure non-`pipeline:` files under `commands/` are left untouched
- [ ] 2.4 When only orphaned command files remain (skill dir already gone), still remove the command files

## 3. Codex shadow detection parity

- [ ] 3.1 Run personal-skill detection / relocation for every host in the install loop (not only `h === "claude"`)
- [ ] 3.2 Supply a host-appropriate backup base for Codex (`dirname` of the resolved Codex skills dir / `CODEX_HOME` parent)
- [ ] 3.3 Neutralize or host-generalize shadow warning copy where it incorrectly assumes Claude marketplace plugin wording
- [ ] 3.4 Verify managed-marker write already covers Codex staging (no regression); add assertion if missing

## 4. Tests

- [ ] 4.1 Test: with `CLAUDE_CONFIG_DIR` temp dir, install (or unit-level `installClaudeCommands`) writes command bodies referencing the temp skill path, not `~/.claude/skills/pipeline`
- [ ] 4.2 Test: Claude uninstall removes `pipeline:<op>.md` files under the config-dir commands path and preserves an unrelated command file
- [ ] 4.3 Test: dry-run Claude uninstall does not delete command files
- [ ] 4.4 Test: Codex unmanaged personal skill → `detectPersonalSkill("codex")` reports shadowing; managed marker → not shadowing
- [ ] 4.5 Test: `CODEX_HOME` override is used for Codex detection / backup base
- [ ] 4.6 Optional smoke: `ci-install-smoke` (or install subprocess test) asserts one generated command file path under isolated `CLAUDE_CONFIG_DIR`

## 5. Verification

- [ ] 5.1 Run install-focused tests (`node --test scripts/install.test.mjs` or repo-equivalent)
- [ ] 5.2 Run full `npm run ci` from repo root and fix any failures
- [ ] 5.3 Confirm no application changes outside install packaging/tests (no core engine behavior change; no dual-SKILL.md generator)
