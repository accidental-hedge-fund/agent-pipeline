## Context

`scripts/install.mjs` installs the pipeline skill into each host’s skills directory and, for Claude, also writes namespaced command files into `<claudeBase>/commands/pipeline:<name>.md` via `renderClaudeCommand(op, skillPath)`.

Today:

1. **Hardcoded skill path** — `installClaudeCommands` always passes `"~/.claude/skills/pipeline"` into `renderClaudeCommand`, even when `claudeBase()` is `$CLAUDE_CONFIG_DIR`. The skill tree is correctly installed under the config dir, but every `/pipeline:*` command still points at the default home path.
2. **Uninstall orphans** — `uninstallHost` only `rm -rf`s `<skillsDir>/pipeline`. Command files under `<claudeBase>/commands/pipeline:*.md` remain and continue to invoke a missing skill path.
3. **Claude-only shadow guard** — `detectPersonalSkill(host)` already takes a host and resolves `HOSTS[host].skillsDir()`, and staging always writes `.pipeline-installer-managed`. The install loop, however, only runs detection/relocation when `h === "claude"`. A pre-existing unmanaged Codex skill is overwritten without warning.

Plugin marketplace command generation in `scripts/build.mjs` still uses a `~/.claude/…` placeholder and rewrites via `pluginifyCommandFile` to `${CLAUDE_PLUGIN_ROOT}`; that path is not this bug.

## Goals / Non-Goals

**Goals:**

- Personal Claude installs under `CLAUDE_CONFIG_DIR` emit command files whose Invoke path matches the installed skill directory.
- Uninstall of the Claude host is complete: skill dir + installer-written command files.
- Codex personal installs get the same managed-marker shadow / relocate / skip semantics as Claude.
- Tests prove all three behaviors; `npm run ci` green.

**Non-Goals:**

- Full dual-host SKILL.md content parity generator (follow-up).
- Changing `renderClaudeCommand` signature beyond using a correct `skillPath` at the install call site.
- Changing plugin marketplace packaging paths (`pluginifyCommandFile` / `${CLAUDE_PLUGIN_ROOT}`).
- Uninstalling user-authored non-`pipeline:` command files or Codex agent YAMLs outside the skill tree (Codex agents live *inside* the skill dir and are removed with it).
- Cross-host lock / concurrency work (#450 family).

## Decisions

### Decision: Pass absolute resolved skill path at install time

**Choice:** `installClaudeCommands` computes  
`skillPath = join(claudeBaseDir, "skills", "pipeline")`  
(absolute via existing `claudeBase()` / `resolve`) and passes that into `renderClaudeCommand`.

**Why not keep `~/.claude/...` for the default case:** Tilde is shell sugar; Claude command execution is not reliably a login shell. An absolute path is correct for both default home and `CLAUDE_CONFIG_DIR`.

**Why not change `build.mjs` plugin generation:** Plugin commands are rewritten to `${CLAUDE_PLUGIN_ROOT}`; different install channel.

### Decision: Uninstall only removes known `pipeline:<op>.md` files

**Choice:** On Claude uninstall, delete `<claudeBase>/commands/pipeline:<name>.md` for each entry in `OPERATION_SURFACE` (same set install writes). Do not glob-delete arbitrary user files. If a file is already missing, continue (idempotent).

**Why not delete all `pipeline:*.md`:** Safer against future user-authored names outside `OPERATION_SURFACE`; still covers every file this installer writes. Optionally log each removal.

**Codex uninstall:** No separate commands directory; agents are under the skill tree — existing `rm -rf dest` is sufficient. No change required beyond Claude command cleanup.

### Decision: Reuse `detectPersonalSkill` / `offerRelocation` for every host

**Choice:** In the install loop, for each host in `hosts`, call `detectPersonalSkill(h)` and, when shadowing, `offerRelocation(dest, hostBackupBase(h), dryRun)`.

`hostBackupBase`:

- Claude → `claudeBase()` (existing)
- Codex → parent of `codexSkillsDir()` (i.e. `CODEX_HOME` when set, else the resolved `~/.codex` or `~/.agents` base)

Backup path shape stays `pipeline.<unique>.bak` under that base (outside `skills/`).

**Why not a Codex-only fork:** Detection already is host-generic; only the call site and backup base were Claude-hardcoded.

**Warning copy:** Prefer host-neutral wording (“would overwrite a personal pipeline skill at …”) so Codex does not claim “plugin’s `/pipeline`” incorrectly. Small string tweak is allowed where the same helper is shared.

### Decision: Tests prefer injectable helpers + real temp dirs

Match existing `install.test.mjs` patterns: set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to temp dirs, assert filesystem outcomes and exported helpers. Subprocess install smoke may assert one command file body contains the custom config-dir skill path if cheap.

## Risks / Trade-offs

- **[Risk] Absolute paths break if the user moves their config dir without reinstall** → Mitigation: same as skill tree today; reinstall/update is the supported repair. Document that commands track the path at install time.
- **[Risk] Uninstall misses files if `OPERATION_SURFACE` shrinks after an older install wrote more names** → Mitigation: acceptable; residual orphan is only possible for *removed* ops. Optional enhancement: also remove any remaining `pipeline:*.md` that match a prefix and were written by us — deferred; start with OPERATION_SURFACE set.
- **[Risk] Codex base resolution has three candidates (`CODEX_HOME`, `~/.codex`, `~/.agents`)** → Mitigation: backup base = `dirname(skillsDir())` so it always matches the install target’s root.
- **[Risk] Shared warning text is Claude-plugin-centric** → Mitigation: neutral wording in the shared helper when touching that path for multi-host use.

## Migration Plan

- No data migration. Next `install` / `update` rewrites command files with correct paths.
- Users with orphaned `pipeline:*.md` after a prior uninstall: re-install then uninstall, or delete those files once; fixed uninstall prevents new orphans.
- Rollback: revert `install.mjs` + tests; no schema/API surface.

## Open Questions

- None blocking implementation. Optional follow-up: uninstall also sweeps historical `pipeline:*.md` not in current `OPERATION_SURFACE` if we later drop ops.
