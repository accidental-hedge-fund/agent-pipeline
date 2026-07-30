## 1. Claude command path at install (shell-safe)

- [x] 1.1 Change `installClaudeCommands` to pass the resolved absolute skill path (`join(claudeBaseDir, "skills", "pipeline")`) into `renderClaudeCommand` instead of the hardcoded `~/.claude/skills/pipeline` string
- [x] 1.2 Make Invoke-line path emission shell-safe in `renderClaudeCommand` (or a helper it calls): quote/escape the resolved skill/script path so spaces and shell-significant characters do not split the `node …/pipeline.mjs` token
- [x] 1.3 Confirm default (no `CLAUDE_CONFIG_DIR`) still writes under home `.claude/commands/` with a body path that resolves to that home skill dir (absolute form OK)
- [x] 1.4 Command filenames remain generated only from `OPERATION_SURFACE` (no second list)

## 2. Claude uninstall command cleanup

- [x] 2.1 Extend `uninstallHost("claude", …)` to remove each `<claudeBase>/commands/pipeline:<name>.md` for `OPERATION_SURFACE` (idempotent if missing)
- [x] 2.2 **Do not return early** when the skill directory is absent — command cleanup always runs for Claude
- [x] 2.3 Include command-file removal (and skill-dir removal when present) in dry-run messaging without deleting files
- [x] 2.4 Ensure non-`pipeline:` / non-`OPERATION_SURFACE` files under `commands/` are left untouched
- [x] 2.5 When only orphaned command files remain (skill dir already gone), still remove the command files and exit 0

## 3. Codex shadow detection parity

- [x] 3.1 Run personal-skill detection / relocation for **every** selected host in the install loop (not only `h === "claude"`), including `--host all`
- [x] 3.2 Supply backup base via `dirname(HOSTS[h].skillsDir())` only — no parallel hardcoded `~/.codex` when `CODEX_HOME` is set
- [x] 3.3 Preserve dry-run non-mutation for shadow handling: warn/report intended backup path only; never rename, write marker, or install files under `--dry-run`
- [x] 3.4 Neutralize or host-generalize shadow warning copy where it incorrectly assumes Claude marketplace plugin wording
- [x] 3.5 Confirm managed-marker write remains staging-only (`stageInto` before `renameSync`) for Codex and Claude; no post-rename second write
- [x] 3.6 Confirm relocation failure leaves skill at original path; successful relocate + later install failure leaves skill at the announced unique backup path (existing `relocatePersonalSkill` uniqueness)

## 4. Tests

- [x] 4.1 Test: with `CLAUDE_CONFIG_DIR` temp dir, **every** `OPERATION_SURFACE` command file body references the absolute config-dir skill path and does **not** contain `~/.claude/skills/pipeline`
- [x] 4.2 Test: path containing a space is shell-quoted/escaped in the Invoke line (still executable as a single path token)
- [x] 4.3 Test: default-home install (env unset) embeds absolute home skill path (or verified equivalent) for every op file
- [x] 4.4 Test: dry-run Claude install writes no command files
- [x] 4.5 Test: Claude uninstall removes all `pipeline:<op>.md` files and the skill dir; preserves an unrelated command file
- [x] 4.6 Test: skill directory absent + orphan commands present → uninstall still removes those commands (no early return)
- [x] 4.7 Test: dry-run Claude uninstall does not delete command files and reports intended removal
- [x] 4.8 Test: Codex unmanaged personal skill → shadowing; managed marker → not shadowing / no shadow warning on install
- [x] 4.9 Test: Codex dry-run with unmanaged skill leaves the skill in place (no rename, no marker, no skill tree write)
- [x] 4.10 Test: non-TTY auto-relocate for Codex; TTY decline skips only the Codex host (other hosts still install under `--host all` when applicable)
- [x] 4.11 Test: `CODEX_HOME` override used for Codex detection and backup base (`dirname(skillsDir)`)
- [x] 4.12 Test: fresh Codex install writes `.pipeline-installer-managed` via staging; dry-run does not
- [x] 4.13 Optional smoke: `ci-install-smoke` asserts generated command body path under isolated `CLAUDE_CONFIG_DIR` if cheapest end-to-end gate

## 5. Verification

- [x] 5.1 Run install-focused tests (`node --test scripts/install.test.mjs` or repo-equivalent)
- [x] 5.2 Run `node scripts/build.mjs --check` and full `npm run ci` from repo root (includes install smoke + OpenSpec validate); fix any failures
- [x] 5.3 Confirm no application changes outside install packaging/tests (no core engine behavior change; no dual-SKILL.md generator; plugin personal-path bug only)
