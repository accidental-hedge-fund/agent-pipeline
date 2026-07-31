## Context

`scripts/install.mjs` installs the pipeline skill into each host’s skills directory and, for Claude, also writes namespaced command files into `<claudeBase>/commands/pipeline:<name>.md` via `renderClaudeCommand(op, skillPath)`.

Today:

1. **Hardcoded skill path** — `installClaudeCommands` always passes `"~/.claude/skills/pipeline"` into `renderClaudeCommand`, even when `claudeBase()` is `$CLAUDE_CONFIG_DIR`. The skill tree is correctly installed under the config dir, but every `/pipeline:*` command still points at the default home path. The path is also interpolated unquoted into `` `node ${skillPath}/scripts/pipeline.mjs …` ``, so spaces / shell-significant characters in a custom config dir break the Invoke line.
2. **Uninstall orphans** — `uninstallHost` returns early when the skill dir is absent and only `rm -rf`s `<skillsDir>/pipeline` when present. Command files under `<claudeBase>/commands/pipeline:*.md` remain and continue to invoke a missing skill path.
3. **Claude-only shadow guard** — `detectPersonalSkill(host)` already takes a host and resolves `HOSTS[host].skillsDir()`, and `stageInto` always writes `.pipeline-installer-managed` into staging before rename. The install loop, however, only runs detection/relocation when `h === "claude"`. A pre-existing unmanaged Codex skill is overwritten without warning.

Plugin marketplace command generation in `scripts/build.mjs` still uses a `~/.claude/…` placeholder and rewrites via `pluginifyCommandFile` to `${CLAUDE_PLUGIN_ROOT}`; that path is not this bug.

## Goals / Non-Goals

**Goals:**

- Personal Claude installs under `CLAUDE_CONFIG_DIR` emit command files whose Invoke path matches the installed skill directory, shell-safe for paths with spaces/special characters.
- Uninstall of the Claude host is complete and independent of skill-dir presence: installer-written command files are always cleaned for `OPERATION_SURFACE`, plus the skill dir when present.
- Codex personal installs get the same managed-marker shadow / relocate / skip / dry-run-non-mutating semantics as Claude.
- Tests prove all three behaviors (every command file, not one representative); `npm run ci` green.

**Non-Goals:**

- Full dual-host SKILL.md content parity generator (follow-up).
- Changing plugin marketplace packaging paths (`pluginifyCommandFile` / `${CLAUDE_PLUGIN_ROOT}`).
- Uninstalling user-authored non-`pipeline:` command files or Codex agent YAMLs outside the skill tree (Codex agents live *inside* the skill dir and are removed with it).
- Cross-host lock / concurrency work (#450 family).
- Historical sweep of `pipeline:*.md` names no longer in `OPERATION_SURFACE` (acceptable residual if an op is later removed).

## Decisions

### Decision: Pass absolute resolved skill path at install time (shell-safe)

**Choice:** `installClaudeCommands` computes  
`skillPath = join(claudeBaseDir, "skills", "pipeline")`  
(absolute via existing `claudeBase()` / `resolve`) and passes that into `renderClaudeCommand`.

**Shell safety:** `renderClaudeCommand` (or a tiny helper next to it in `build.mjs`) SHALL embed the skill path in the Invoke line so a path with spaces or shell-significant characters remains a single argv token. Preferred form: single-quote the absolute skill path (and escape any embedded `'` as `'\''` / POSIX `''` style) so the generated line is equivalent to:

```text
`node '/custom dir/skills/pipeline'/scripts/pipeline.mjs …`
```

or, more cleanly, single-quote the full script path:

```text
`node '/custom dir/skills/pipeline/scripts/pipeline.mjs' …`
```

Prefer quoting the full `…/scripts/pipeline.mjs` path once. Do not leave an unquoted absolute path when that path can contain spaces (today’s bare `${skillPath}/scripts/pipeline.mjs` interpolation is the bug).

**Why not keep `~/.claude/...` for the default case:** Tilde is shell sugar; Claude command execution is not reliably a login shell. An absolute path is correct for both default home and `CLAUDE_CONFIG_DIR`.

**Why not change `build.mjs` plugin generation beyond shared quoting:** Plugin commands are rewritten to `${CLAUDE_PLUGIN_ROOT}`; different install channel. If quoting lives inside `renderClaudeCommand`, plugin/personal both benefit without changing the plugin rewrite path.

### Decision: Uninstall only removes known `pipeline:<op>.md` files; independent of skill dir

**Choice:** On Claude uninstall, delete `<claudeBase>/commands/pipeline:<name>.md` for each entry in `OPERATION_SURFACE` (same set install writes — single source of truth; no second filename list). Do not glob-delete arbitrary user files. Missing individual files are ignored (idempotent).

**Critical control-flow fix:** `uninstallHost` MUST NOT return early solely because the skill directory is absent. Command cleanup runs whenever `host === "claude"`, whether or not `<skillsDir>/pipeline` exists. Skill-dir removal remains best-effort / present-only.

**Dry-run:** Report that skill dir (if present) and each command file *would* be removed; delete nothing.

**Codex uninstall:** No separate commands directory; agents are under the skill tree — existing `rm -rf dest` is sufficient. No change required beyond Claude command cleanup.

### Decision: Reuse `detectPersonalSkill` / `offerRelocation` for every host

**Choice:** In the install loop, for each host in `hosts` (including under `--host all`), call `detectPersonalSkill(h)` and, when shadowing, `offerRelocation(dest, hostBackupBase(h), dryRun)`.

`hostBackupBase(h)`:

- Derived only from existing resolvers: `dirname(HOSTS[h].skillsDir())`.
- Claude → parent of `…/skills` = `claudeBase()` (honors `CLAUDE_CONFIG_DIR`).
- Codex → parent of `codexSkillsDir()` (honors `CODEX_HOME`, else existing `~/.codex` / `~/.agents` preference).
- **No parallel hardcoded `~/.codex` path construction** when `CODEX_HOME` is set.

Backup path shape stays `pipeline.<unique>.bak` under that base (outside `skills/`), via existing `uniqueBackupPath` / `relocatePersonalSkill` (never overwrites an existing backup; concurrent EEXIST retries).

**Dry-run is fully non-mutating for shadow handling:** When `dryRun` is true, the installer MAY emit a warning and report the intended relocation (`uniqueBackupPath` for messaging only) but MUST NOT:

- `renameSync` / relocate an unmanaged skill
- write `.pipeline-installer-managed`
- overwrite or write any skill/command files for that host

Existing `offerRelocationWith` already short-circuits dry-run before relocate; preserve that invariant and cover it with a Codex regression test.

**TTY decline:** Leave personal install untouched; skip *only that host’s* install; exit 0. Other hosts in `--host all` still proceed.

**Managed marker:** `stageInto` already writes `MANAGED_MARKER` into the staging directory before `renameSync` — keep that as the single write site for both Claude and Codex. Explicit task + test: successful Codex install leaves `<codexSkillsDir>/pipeline/.pipeline-installer-managed`; dry-run writes nothing. Do not add a second post-rename marker write.

**Warning copy:** Prefer host-neutral wording (“would overwrite a personal pipeline skill at …”) so Codex does not claim “plugin’s `/pipeline`” incorrectly. Small string tweak is allowed where the same helper is shared.

**Failure recoverability:** If relocation fails, the personal skill remains at the original path (rename is atomic) and install for that host fails visibly. If install fails after a successful relocation, the personal skill remains at the announced unique backup path and is never overwritten by a later backup collision (`relocatePersonalSkill` uniqueness). Document this in tests/comments; no new recovery UI.

### Decision: Tests prefer injectable helpers + real temp dirs

Match existing `install.test.mjs` patterns: set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` to temp dirs, assert filesystem outcomes and exported helpers. Subprocess install smoke may assert command bodies under isolated `CLAUDE_CONFIG_DIR`.

Required coverage (falsifiable):

| Area | Cases |
|------|--------|
| Command path | Every `OPERATION_SURFACE` op file under config-dir; body contains absolute skill path; body does **not** contain `~/.claude/skills/pipeline`; default-home absolute path when env unset; dry-run writes no command files; path with a space is shell-quoted in the Invoke line |
| Uninstall | Full install then uninstall removes skill + all command files; skill absent + orphan commands still removed; unrelated commands preserved; dry-run preserves commands and reports intent |
| Codex shadow | Unmanaged → shadowing; managed marker → no warning / overwrite; dry-run preserves unmanaged skill (no rename, no marker, no install write); non-TTY auto-relocate; TTY decline skips only that host; `CODEX_HOME` detection + backup base; `--host all` runs detection per host; backup uniqueness / no overwrite |

## Approach (repo pattern)

Follow the existing personal-install packaging pattern in `scripts/install.mjs`:

- **Host path resolution** — `claudeBase()` / `codexSkillsDir()` already honor env overrides; all new paths derive from those + `dirname(skillsDir())` for backup bases (same pattern as Claude’s current `offerRelocation(dest, claudeBase(), dryRun)` call site ~line 1050).
- **Managed marker atomicity** — `stageInto` writes `MANAGED_MARKER` into the staging tree before `renameSync` (~line 549–551). Codex reuses this; do not invent a second write site.
- **Shadow + dry-run** — `offerRelocationWith` already treats `dryRun` as warn-only (~line 472–478). Extend the *call site* to every host; do not weaken dry-run.
- **Command surface single source** — `OPERATION_SURFACE` from `scripts/build.mjs` drives both install and uninstall filenames (same loop as `installClaudeCommands` today ~line 563–566).
- **Tests** — `scripts/install.test.mjs` uses temp `CLAUDE_CONFIG_DIR` / `CODEX_HOME` + exported helpers; extend that file rather than introducing a parallel harness.

## Risks / Trade-offs

- **[Risk] Absolute paths break if the user moves their config dir without reinstall** → Mitigation: same as skill tree today; reinstall/update is the supported repair.
- **[Risk] Uninstall misses files if `OPERATION_SURFACE` shrinks after an older install wrote more names** → Mitigation: acceptable; residual orphan only for *removed* ops. Deferred: historical `pipeline:*.md` sweep.
- **[Risk] Codex base resolution has three candidates (`CODEX_HOME`, `~/.codex`, `~/.agents`)** → Mitigation: backup base = `dirname(skillsDir())` so it always matches the install target’s root.
- **[Risk] Shared warning text is Claude-plugin-centric** → Mitigation: neutral wording in the shared helper when touching that path for multi-host use.
- **[Risk] Quoting changes plugin command body shape slightly if shared via `renderClaudeCommand`** → Mitigation: acceptable if paths without spaces remain readable; assert personal install path with spaces; plugin rewrite path remains `${CLAUDE_PLUGIN_ROOT}` and out of scope for path *value* fix.
- **[Risk] Early return in `uninstallHost` when skill missing is easy to reintroduce** → Mitigation: explicit regression test “skill absent, orphan commands present.”

## Migration Plan

- No data migration. Next `install` / `update` rewrites command files with correct shell-safe paths.
- Users with orphaned `pipeline:*.md` after a prior uninstall: re-install then uninstall, or delete those files once; fixed uninstall prevents new orphans.
- Rollback: revert `install.mjs` / `build.mjs` quoting if any / tests; no schema/API surface.

## Open Questions

- None blocking implementation. Optional follow-up: uninstall also sweeps historical `pipeline:*.md` not in current `OPERATION_SURFACE` if we later drop ops.
