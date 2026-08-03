## Context

Today the installer recognizes `--host claude|codex|grok|all`. Claude and Codex
are full tree installs (`core/` + host overlay + launcher shim + managed
marker). Grok is a symlink to the Claude skill tree. OpenCode is already a
**registered harness adapter** (`core/scripts/harness-adapters/opencode.ts`) for
stage execution, but it is **not** an installer host: there is no
`hosts/opencode/`, no `HOSTS.opencode`, and no native OpenCode command file.

OpenCode discovers skills and commands under its config directory:

| Surface | Default path | Notes |
| --- | --- | --- |
| Global config base | `~/.config/opencode/` | Documented OpenCode layout |
| Skills | `<base>/skills/` | Claude-compatible skill trees are discoverable here |
| Commands | `<base>/commands/*.md` | Filename becomes slash command (`pipeline.md` → `/pipeline`) |
| Config-dir override | `OPENCODE_CONFIG_DIR` | OpenCode searches this directory like `.opencode` / global config for agents, commands, plugins (and by extension skills) |

OpenCode custom commands are **prompt templates** (markdown frontmatter + body),
not pure side-effect CLIs. Shell injection (`!`command``) can run a process and
inject stdout into the prompt; pure no-LLM side-effect slash commands are not a
supported plugin path (upstream issue #30268 closed as not planned; plugin
`command.execute.before` cannot suppress the LLM turn — #28292). Therefore the
design MUST be explicitly **LLM-mediated**: `/pipeline --version` SHALL
**deterministically obtain launcher stdout via shell inject** and **avoid
embedding instructional skill text** in the template, while remaining honest
that OpenCode still starts a prompt turn and residual presentation goes through
the host’s LLM session. Do **not** claim a host-level non-LLM stdout return.

The shared launcher (`hosts/_shared/entry.template.mjs` → `pipeline.mjs` in the
skill tree) already implements `--version` / `-V` by reading
`core/package.json` without provisioning deps (`cli-version-flag`).

## Goals / Non-Goals

**Goals:**

- First-class `install|update|uninstall --host opencode` that owns only OpenCode
  artifacts.
- OpenCode skill tree with managed marker, core, host overlay, and launcher.
- Native `/pipeline` command under OpenCode `commands/` that routes arguments to
  that launcher with argv-safe forwarding (LLM-mediated template + shell inject).
- `/pipeline --version` and `/pipeline -V` **inject** the same version string as
  the installed launcher (bridge/launcher stdout equality), with agent
  instruction to report only that string and without embedding generic
  skill-instruction content in the template.
- Shadow detection / dry-run / update / uninstall parity with other tree hosts.
- Document OpenCode as a supported host; regression tests; `npm run ci` green.

**Non-Goals:**

- Full namespaced `pipeline:<op>` OpenCode command set in this change (may land
  later via the existing single-source operation list).
- Pure no-LLM TUI plugin command registration (not supported upstream).
- Making OpenCode the default implementer for Claude/Codex profiles.
- Changing Claude, Codex, or Grok install destinations or markers.
- Expanding `hostCoverage` enum values in a breaking way for existing
  desktop integrators.
- Auto-merge or review-rigor changes.

## Decisions

### D1 — Full tree host, not Grok-style symlink

**Choice:** `HOSTS.opencode` is `installMode: "tree"` like Claude/Codex:
stage `core/` + `hosts/opencode` overlay + shared launcher into
`<opencodeBase>/skills/pipeline`, write `.pipeline-installer-managed`.

**Why:** OpenCode needs host-specific SKILL.md (invocation token `/pipeline`,
OpenCode-oriented conventions) and a command surface that embeds the **resolved
OpenCode skill path**. Symlinking to Claude’s tree would couple OpenCode command
paths to Claude’s install and reintroduce the “skill text only” failure mode
when Claude is absent.

**Alternatives considered:**

- *Symlink to Claude (like Grok)* — fails when Claude is not installed; no native
  command file ownership under OpenCode config.
- *Commands only, no skill tree* — loses discoverable skill content for advance
  workflows and breaks launcher locality.

### D2 — OpenCode config base resolution

**Choice:**

```text
opencodeBase =
  process.env.OPENCODE_CONFIG_DIR  (if set and non-empty)
  else path.join(homedir(), ".config", "opencode")
```

Skills: `<opencodeBase>/skills/pipeline`  
Commands: `<opencodeBase>/commands/` (installer-written `pipeline.md` only)

Do **not** hardcode `~/.config/opencode` when `OPENCODE_CONFIG_DIR` is set.
`OPENCODE_CONFIG` (single config **file** path) is **not** used as the install
base — it does not define a skills/commands tree root.

**Why:** Matches OpenCode’s documented config-directory override and mirrors
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` patterns already in the installer.

**Alternatives considered:**

- *Always `~/.config/opencode`* — breaks operators who relocate config.
- *Honor `XDG_CONFIG_HOME` only* — incomplete vs OpenCode’s own
  `OPENCODE_CONFIG_DIR`.

### D3 — Native `/pipeline` command + argv-safe bridge

**Choice:** Installer writes a single OpenCode command file
`<opencodeBase>/commands/pipeline.md` whose template:

1. Embeds the **absolute** path to the installed launcher
   (`…/skills/pipeline/pipeline.mjs` or the host’s canonical entry name).
2. Forwards user arguments via an **argv-preserving** mechanism — **not**
   unquoted shell concatenation of `$ARGUMENTS`.

Preferred implementation shape (pick one at implement time; both satisfy
specs):

- **A (preferred):** A small Node bridge next to the launcher (e.g.
  `opencode-pipeline-bridge.mjs` or reuse `pipeline.mjs` with `process.argv`)
  that OpenCode’s command invokes through a **fixed** shell/node invocation
  whose only variable input is passed as discrete argv (e.g. generate the
  command body to call `node <launcher> -- …` with arguments re-parsed from
  `$ARGUMENTS` by Node’s own argv rules, or pass args via a temp argv file /
  env that the bridge reads without `sh -c` interpolation).
- **B:** Command template instructs the agent to run the absolute launcher with
  discrete argv tokens (no shell string build), and a **fixed** shell injection
  line for version-only short path: `!`node <absolute-launcher> --version``
  with no user-controlled interpolation.

Hard requirement: tests MUST demonstrate that arguments containing spaces or
shell metacharacters are not split or expanded by a shell string, and that
`--version` / `-V` match launcher output byte-for-byte (trim newline OK).

**Why:** Acceptance criteria forbid shell-interpolation / argument-loss bugs;
OpenCode’s `$ARGUMENTS` is a string substitution into a prompt template, so
blind `!`node launcher $ARGUMENTS`` is unsafe.

**Alternatives considered:**

- *Prompt-only “please run pipeline”* — leaves version path as LLM skill dump
  (current failure mode).
- *OpenCode plugin tool* — heavier; optional later optimization if markdown
  command path proves insufficient for version fidelity.

### D4 — Version short-circuit contract (inject + instruction, LLM-mediated host)

**Choice:** When the user invokes `/pipeline --version` or `/pipeline -V`, the
OpenCode command path SHALL shell-inject the installed launcher’s version
short-circuit (via the argv-safe bridge) so inject stdout equals launcher
`--version` / `-V` / `core/package.json` `version`. The command template SHALL
instruct the agent to report **only** that injected version string and SHALL
NOT include the full SKILL.md instructional body (no “how to use the pipeline”
dump). The host surface remains LLM-mediated; the guaranteed contract is
deterministic inject + instruction, not pure process-stdout return without an
LLM turn.

**Why:** OpenCode has no pure side-effect slash-command API. The failure mode
to fix is “skill text / generic usage dump instead of launcher version,” not
“bypass OpenCode’s prompt turn.”

### D5 — Host overlay and profile

**Choice:**

- Add `hosts/opencode/SKILL.md` derived from the Claude host overlay, adapted for
  OpenCode invocation (`/pipeline`) and OpenCode-relevant host notes. Keep stage
  inventory / conventions aligned with other hosts (inventory-symmetric per
  `stage-inventory-ssot` intent).
- Add `core/profiles/opencode.json` with `implementer: "opencode"`, reviewer a
  registered adapter other than opencode (default **`claude`**, matching the
  “non-codex primary → Claude reviewer” pattern used by codex’s reverse pair
  inverted), `invocation: "/pipeline"`, conventions default to a documented
  host file if OpenCode uses one, else the same project conventions pattern
  (`AGENTS.md` / `CLAUDE.md` discovery already host-neutral in engine).
- Installer sets `HOSTS.opencode.profile = "opencode"` so the launcher shim bakes
  that profile.

**Why:** OpenCode as implementer matches the host; the engine already has an
`opencode` adapter. A dedicated profile avoids running OpenCode-host installs
under the Claude implementer by accident.

**Alternatives considered:**

- *Reuse Claude profile* — wrong implementer for OpenCode-primary operators.
- *Reviewer codex* — also valid; pick one default and document override via
  `harnesses:` in repo config.

### D6 — Isolation, lifecycle, shadow detection

**Choice:**

- `--host opencode` installs/updates/uninstalls **only** OpenCode skill +
  installer-owned `commands/pipeline.md` (exact name reserved for this host’s
  base command).
- Uninstall removes skill tree (if managed) and that command file; never
  Claude/Codex/Grok paths; never non-pipeline OpenCode commands.
- Dry-run writes nothing.
- Shadow detection: if `<skills>/pipeline` exists without
  `.pipeline-installer-managed`, apply the same TTY/non-TTY relocation policy as
  Claude/Codex tree hosts (relocate/skip; never silent overwrite).
- `--host all` includes `opencode` when the OpenCode base is detected (or when
  forced via explicit host); ordering: prefer existing tree hosts first; do not
  require Claude install as a prerequisite for OpenCode (unlike Grok).

### D7 — Host path discovery (non-breaking)

**Choice:** Preserve `hostCoverage` enum (`missing` | `claude-only` |
`codex-only` | `both`) as-is for Claude/Codex. If implementation extends
`pipeline path --json`, add an **additive** `hosts.opencode` object
(`available`, optional path) without redefining `hostCoverage` meanings.
Updating `hostCoverage` to include OpenCode is **out of scope** unless done in
a clearly non-breaking, versioned way — prefer additive fields only.

### D8 — Documentation

**Choice:** README install section documents:

```bash
npx github:… install --host opencode
# skill → ~/.config/opencode/skills/pipeline
# command → ~/.config/opencode/commands/pipeline.md
```

Note `OPENCODE_CONFIG_DIR`, restart/reload expectations if any, and that
`/pipeline --version` hits the launcher. Installer usage header and unknown
`--host` errors list `opencode`.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| OpenCode still routes slash commands through an LLM session | **Accepted as host reality.** Spec version path as deterministic inject equality + agent instruction, no skill-instruction dump; bridge for argv; README/spec state LLM mediation explicitly. Do not claim no-LLM stdout return. |
| `$ARGUMENTS` shell injection bugs | Forbid unquoted shell concat; require bridge/execFile tests with spaces and metacharacters. |
| `OPENCODE_CONFIG_DIR` semantics drift upstream | Pin documented behavior in design + tests with env override; fail closed to default base when unset. |
| Skill vs command dual surface confuses operators | README: skill = discoverable instructions; command = native `/pipeline` entry that runs the launcher. |
| Full namespaced command parity deferred | Explicit non-goal; follow-up issue if needed. |
| Profile reviewer choice (claude vs codex) | Default claude; repo `harnesses.reviewer` override remains. |
| `plugin/` mirror | OpenCode host is installer-only (like Codex overlay); do **not** require plugin marketplace packaging unless build already mirrors all hosts — confirm at implement: Codex is not in plugin/; OpenCode should follow Codex (installer host, not Claude plugin mirror). |

## Migration Plan

1. Land host overlay + installer + tests on the feature branch.
2. Operators run `install --host opencode` (or `update`).
3. Existing Claude/Codex installs unchanged.
4. Rollback: `uninstall --host opencode` removes only OpenCode artifacts.

## Open Questions

1. Exact OpenCode command frontmatter fields required for best UX (`description`,
   optional `agent`) — confirm against current OpenCode docs at implement time
   (golden rule: verify external shapes; do not guess).
2. ~~Whether a minimal OpenCode plugin (custom tool) is needed if markdown+bridge
   cannot present raw version stdout cleanly~~ — **Resolved:** upstream does not
   support pure no-LLM side-effect slash commands (#30268 not planned; #28292
   plugins cannot suppress LLM turn). Stay on markdown + shell inject + bridge;
   document LLM mediation rather than claim direct stdout.
3. Whether `--host all` auto-detect should treat presence of
   `~/.config/opencode` alone as sufficient (yes per D6) even when empty.
