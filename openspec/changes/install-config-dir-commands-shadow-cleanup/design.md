## Context

`scripts/install.mjs` already:

- Resolves Claude’s base via `claudeBase()` (`CLAUDE_CONFIG_DIR` or `~/.claude`) and installs the skill under `<base>/skills/pipeline`.
- Writes namespaced Claude commands via `installClaudeCommands(claudeBase(), …)` into `<base>/commands/pipeline:<name>.md`, but hardcodes the skill path argument as `"~/.claude/skills/pipeline"` when calling `renderClaudeCommand`.
- Uninstalls with `uninstallHost`, which removes only `<skillsDir>/pipeline` (or unlinks the Grok symlink). Claude command files outside the skill tree are left behind.
- Shadow-detects unmanaged personal skills with `detectPersonalSkill(host)` + `.pipeline-installer-managed`, but the install loop only runs that path when `h === "claude"`. Codex tree installs overwrite `…/skills/pipeline` without relocation.

`renderClaudeCommand(op, skillPath)` in `scripts/build.mjs` already accepts a skill path; the bug is the install call site, not the renderer API. Codex agent YAML files live **inside** the skill tree (`…/pipeline/agents/`), so they are removed with the skill dir and do not need separate uninstall logic.

Related closed work (#450/#567) hardened install locks; this change does not touch lock semantics.

## Goals / Non-Goals

**Goals:**

- Embed the **resolved** Claude skill directory into every installer-written `/pipeline:*` command file so config-dir installs invoke the skill that was just installed.
- Make Claude uninstall remove installer-written `pipeline:*.md` command files under the same config base used at install.
- Give Codex the same personal-skill shadow/relocation/skip protection Claude already has (marker-based, TTY prompt vs non-TTY auto-relocate).
- Prove the three behaviors with unit tests; keep `npm run ci` green.

**Non-Goals:**

- Full dual-host SKILL.md content parity generator (issue out of scope).
- Changing the Codex agent YAML layout or generating Claude-style command files for Codex.
- Uninstalling operator-authored non-`pipeline:` command files.
- Grok shadow detection redesign beyond existing symlink-safe uninstall (Grok is not a tree overwrite of a personal skill at the same path in the same way).
- Plugin marketplace install path layout changes beyond remaining correct when env overrides are unset.
- Auto-merge, review-mode changes, or install lock redesign.

## Decisions

### D1 — Pass absolute (or real resolved) skill path into `renderClaudeCommand` at install time

**Choice:** In `installClaudeCommands`, pass the path of the skill directory that install just targeted — i.e. `join(claudeBaseDir, "skills", "pipeline")` or a shared helper equivalent to `claudeSkillDir()` — instead of the literal `"~/.claude/skills/pipeline"`.

Prefer an absolute resolved path (same family as the Grok symlink target comment already in install) so command Invoke lines remain valid when the operator’s shell does not expand `~` the same way, and so config-dir installs never mention the default home path.

**Alternatives considered:**

- *Keep `~`-style path built from config dir* — still wrong if config dir is absolute and not under home; tilde form is ambiguous for non-home config dirs.
- *Change only `build.mjs` plugin generation* — does not fix the install call site that writes live command files under `CLAUDE_CONFIG_DIR`.

### D2 — Uninstall only deletes namespaced installer command files

**Choice:** On Claude uninstall, after (or before) skill-tree removal, delete files matching `pipeline:*.md` under `<claudeBase>/commands/`. Do not remove other command files. Dry-run logs intended deletions without writing.

Optional hardening (implementation MAY): only delete files that look installer-owned (e.g. contain the pipeline skill invoke pattern). Minimum bar is name-prefix `pipeline:` under the resolved commands dir, matching what install writes.

**Alternatives considered:**

- *Track a manifest of written files* — more correct for future renames but heavier than the current OPERATION_SURFACE-driven writer; prefix match matches today’s writer.
- *Leave orphans and document manual cleanup* — fails the issue’s required behavior.

### D3 — Host-loop shadow gate for every tree-mode host, not Claude-only

**Choice:** Generalize the install-loop condition from `if (h === "claude")` to tree-mode hosts that install into `skillsDir()/pipeline` with the managed marker (today: `claude` and `codex`). Call `detectPersonalSkill(h)` and, when shadowing, `offerRelocation` with a host-appropriate backup base:

| Host   | Skills dest                         | Backup base                                      |
|--------|-------------------------------------|--------------------------------------------------|
| claude | `claudeBase()/skills/pipeline`      | `claudeBase()`                                   |
| codex  | `codexSkillsDir()/pipeline`         | parent of skills dir (`CODEX_HOME` or discovered home) |

Reuse existing `detectPersonalSkill`, `offerRelocationWith`, `relocatePersonalSkill`, and marker write in `stageInto` — no second marker design.

**Alternatives considered:**

- *Codex-only second code path* — duplicates TTY/non-TTY policy and drifts from Claude.
- *Always overwrite with no prompt for Codex* — current bug; rejected by the issue.

### D4 — Grok stays out of tree shadow overwrite path

**Choice:** Do not run personal-skill tree overwrite relocation for `installMode: "symlink-claude"`. Grok install already refuses destructive directory delete and only manages a symlink; shadow semantics differ. Out of scope unless a later issue unifies them.

### D5 — Tests stay pure (tmpdir + env overrides)

**Choice:** Extend `scripts/install.test.mjs` with isolated temp dirs and `CLAUDE_CONFIG_DIR` / `CODEX_HOME` env overrides (existing pattern). No real network, git, or user home mutation. Export any new pure helpers needed for unit coverage (same style as `detectPersonalSkill` / `offerRelocationWith`).

## Risks / Trade-offs

- **[Risk] Absolute paths in command files look less portable across machines** → **Mitigation:** Commands are machine-local under the user’s config dir; install is already host-local. Absolute paths match how the skill is actually laid down.
- **[Risk] Uninstall deletes a user-authored `pipeline:foo.md` that was not installer-written** → **Mitigation:** Only match the installer namespace `pipeline:*.md` under the config `commands/` dir; document that the namespace is installer-owned. Optional content fingerprint later if needed.
- **[Risk] Codex backup base differs across `~/.codex` vs `~/.agents` discovery** → **Mitigation:** Derive backup base from the same resolution used for `codexSkillsDir()` (parent of the resolved skills dir), not a second ad-hoc home guess.
- **[Risk] Partial uninstall if skill remove fails mid-way** → **Mitigation:** Best-effort remove commands and skill independently; dry-run and logs name both targets. Prefer skill removal still attempted if command cleanup fails (or vice versa) so one failure mode does not leave both artifacts forever without a second uninstall.

## Migration Plan

1. Ship as a normal installer code change; no data migration of existing skills.
2. Operators with orphaned `commands/pipeline:*.md` after prior uninstalls: re-install then uninstall once, or delete the namespace files manually; no automatic sweep of foreign config dirs.
3. Operators with personal Codex skills: first post-change `install --host codex` will prompt/auto-relocate instead of silent overwrite — intentional safety improvement.
4. Rollback: revert the installer change; no schema or label migration.

## Open Questions

None blocking. Implementation may choose absolute vs config-relative skill path string form as long as config-dir installs never hardcode `~/.claude/skills/pipeline` and tests lock the chosen form.
