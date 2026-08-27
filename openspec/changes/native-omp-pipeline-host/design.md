## Context

See proposal.md for motivation. Builtins today are `claude`, `codex`, `grok`, and `opencode`. `pi` is a stage adapter (`core/scripts/harness-adapters/pi.ts`), not an outer host. OMP discovers OpenCode markdown commands (`opencode` provider, priority 55), so an OMP `/pipeline` session currently loads `~/.config/opencode/commands/pipeline.md`. That file is an LLM-mediated template that shell-injects PATH `node` into `opencode-pipeline-bridge.mjs`.

OMP native layout (verified against Oh My Pi docs):

| Surface | Path | Notes |
| --- | --- | --- |
| Global agent root | `~/.omp/agent` | User-level native config. Named OMP profiles use `~/.omp/profiles/<name>/agent` and are not this installer's target. |
| Skills | `~/.omp/agent/skills/<name>/SKILL.md` | Non-recursive one-level discovery. |
| Markdown slash commands | `~/.omp/agent/commands/*.md` | Native provider priority 100, still LLM-expanded. |
| TypeScript custom commands | `~/.omp/agent/commands/<name>/index.ts` | Handler may return void; that path is handled with no LLM prompt. Runs before file-based markdown commands, including OpenCode `pipeline.md`. |
| Project `.omp` | `<cwd>/.omp/...` | Higher skill/command precedence than user. Not installer-managed. |

OMP TypeScript custom commands execute in `AgentSession.prompt` before file-based slash expansion. A native TS `/pipeline` therefore wins over the OpenCode markdown template without deleting it.

Launcher Node bootstrap / `--version` on Node 18–23 is #1236 and is consumed, not re-specified. The OMP command captures `process.execPath` at install time; the launcher may still re-exec onto engines-compliant Node.

#1240 (repository-declared harness roles) is already living law. This change does not re-open that gate.

## Goals / Non-Goals

**Goals:**

- Builtin outer host `omp` with manifest, overlay, installer base, and command surface.
- Install only under global `~/.omp/agent`.
- Native non-LLM TypeScript `/pipeline` that execs the installed `scripts/pipeline.mjs` with captured `process.execPath`, session cwd, and exact argv.
- Additive discovery and `engine-promote --host omp`; `--host all` includes `omp` when the OMP agent base exists (and always as a valid host id).
- Keep adapter id `pi` distinct from outer-host id `omp`.
- `stdout_only` initial lifecycle; portable detach / run-store / event follow.

**Non-Goals:**

- Launcher Node bootstrap (#1236).
- Factory-control identity vs GitHub repo name.
- Hermes/Buzz/Tugboat rewrite.
- Teaching SKILL.md a per-box Node path or changing this machine's PATH.
- Managing project `.omp` directories or named OMP profile dirs (`~/.omp/profiles/<name>/agent`).
- Env override for the OMP install base (`PI_CODING_AGENT_DIR`, `OMP_*`).
- Host-rich OMP notify, detach UI, or a second run-store.
- A harness adapter named `omp`, or collapsing `pi` into the outer host.
- Re-implementing #1240.

## Decisions

### D1 — Full tree host under global `~/.omp/agent` only

**Choice:** `hosts/omp` is `installMode: "tree"`. Base is `$HOME/.omp/agent` (`defaultHomeSegments: [".omp", "agent"]`). Skills: `<base>/skills/pipeline`. No env override. Project `.omp` and named OMP profile agent dirs are user-owned and never written by this installer.

**Why:** Locked install root. OMP project `.omp` would shadow the global skill and create per-repo copies the installer cannot update. An env override would reintroduce the “no env override” failure mode.

**Alternatives considered:**

- *Honor `PI_CODING_AGENT_DIR` / named profiles* — splits the managed tree; rejected by the locked root.
- *Also write `<cwd>/.omp`* — project copies go stale; rejected.
- *Symlink to Claude (Grok-style)* — OMP needs its own command file and overlay; fails when Claude is absent.

### D2 — Outer-host id `omp` is not adapter id `pi`

**Choice:** Registry, manifests, `--host`, and discovery use `omp`. Adapter registry keeps `pi`. Evidence and conformance treat them as different identities. Do not add an `omp` harness adapter in this change.

**Why:** Acceptance criterion 5. `pi` is the Pi Coding Agent CLI stage adapter. OMP is the session host.

**Alternatives considered:**

- *Reuse `pi` as the host id* — collapses adapter and outer host; forbidden.
- *Alias both ids* — same collapse, plus discovery ambiguity.

### D3 — Native TypeScript `/pipeline`, not markdown and not OpenCode reuse

**Choice:** Installer writes an OMP TypeScript custom command at `~/.omp/agent/commands/pipeline/index.ts` (OMP `<name>/index.ts` layout). The command:

1. Is named `pipeline` so the session exposes `/pipeline`.
2. Spawns the installed launcher as a process (no shell).
3. Uses the absolute `process.execPath` captured when `install.mjs` ran, plus the absolute path to `<skill>/scripts/pipeline.mjs`.
4. Forwards the OMP session working directory as spawn `cwd`.
5. Forwards user argv as a discrete argv array (no `$ARGUMENTS` shell concat, no PATH `node`).
6. Surfaces launcher stdout/stderr to the session and returns void so OMP does not start an LLM prompt turn.

The installer SHALL NOT write or treat `~/.config/opencode/commands/pipeline.md` as the OMP surface. It MAY leave an existing OpenCode file in place for OpenCode hosts. OMP TS custom-command dispatch runs before file-based OpenCode markdown, so `/pipeline` in an OMP session hits the native command.

**Why:** OpenCode commands are LLM-mediated. OMP TypeScript custom commands can return void and skip the prompt. Captured `execPath` is the class fix for “PATH `node`” (with #1236 re-exec as the engines floor).

**Alternatives considered:**

- *Markdown `~/.omp/agent/commands/pipeline.md` with shell inject* — still LLM-expanded; repeats the OpenCode failure mode.
- *Reuse OpenCode `pipeline.md`* — current bug.
- *`~/.local/bin/pipeline` wrapper* — extra PATH product; rejected by the user story.

### D4 — Captured launcher executable, not PATH `node`

**Choice:** At install time, bake `process.execPath` into the generated command as an absolute path. The command argv is `[capturedExecPath, absolutePipelineMjs, ...userArgs]`. No `sh -c`. No bare `node`. Launcher bootstrap (#1236) MAY still re-exec a Node ≥ 24 binary; that is out of this change's implementation.

**Why:** Installer Node is known. PATH `node` on this machine is the observed failure. SKILL.md must not teach a per-box Node path.

**Alternatives considered:**

- *PATH `node`* — current OpenCode template; rejected.
- *Hardcode `/usr/bin/node`* — wrong on nvm/fnm/mise boxes; rejected.

### D5 — `omp` profile is bootstrap metadata only

**Choice:** Ship `core/profiles/omp.json` so the launcher can bake `--profile omp` without a special case. Profile fields satisfy the existing profile schema (name, invocation `/pipeline`, a pair of *already registered* adapter names for `harnesses`, `reviewMode: prompt-harness`). Live implementer and reviewer remain `.github/pipeline.yml` (#1240). The profile MUST NOT invent an `omp` adapter. Prefer bootstrap pair `claude` / `codex` (existing adapters) unless implementation finds a schema-legal pair that is clearer; do not set implementer to `pi` as a host alias.

**Why:** Locked decision. Profile load is not the outer-host extension path (`cross-host-profiles`).

**Alternatives considered:**

- *No profile; reuse `opencode`* — couples OMP install to OpenCode presentation defaults.
- *Implementer `pi`* — reads as collapsing host into adapter.

### D6 — Initial lifecycle is `stdout_only` plus portable follow

**Choice:** Manifest declares every required capability area. `material_progress_notify.mapping.surface` is `stdout_only`. Early handoff, event follow, reattach, wait/cancel, terminal cleanup, and terminal summary use the portable baseline: launcher stdout JSON and `pipeline logs --events --follow` / run-store / detach. Do not require an OMP-native monitor tool in this change.

**Why:** Locked initial lifecycle. Shared orchestration already consumes support-or-fallback; no host-name branch.

**Alternatives considered:**

- *Host-rich OMP notify in v1* — extra product; not needed for `/pipeline train`.
- *Skip capability areas* — conformance kit fails.

### D7 — Manifest-driven install; new commands kind `omp-native`

**Choice:** `hosts/omp/outer-host.manifest.json` plus `core/scripts/outer-hosts/builtins/omp.json`. `commandsKind: "omp-native"` is a new kind (not `opencode-native`). Installer dispatch stays on `commandsKind` / install mode, not `if (host === "omp")` in shared orchestration. `BUILTIN_OUTER_HOST_IDS` and `--host` help include `omp`. `installOrder` after OpenCode (50) so tree hosts stay grouped; OMP does not require Claude.

`--host omp` creates `~/.omp/agent` if missing. `--host all` includes `omp` when that base exists, same detection rule as other tree hosts.

**Why:** Outer-host contract: registry is the enumeration source; shared code does not grow a host-name lifecycle switch.

**Alternatives considered:**

- *Reuse `opencode-native`* — wrong command semantics (LLM markdown vs TS).
- *Closed `if (host === "omp")` in orchestration* — violates #784.

### D8 — Discovery and promote are additive

**Choice:** `pipeline path --json` keeps Claude/Codex `hostCoverage`. Add `hosts.omp.available` (and skill path if cheap). `engine-promote --host omp` is valid. Default promote `--host all` includes OMP among hosts the installer supports under `all`.

**Why:** Same non-breaking pattern as OpenCode (#861).

### D9 — Shadow detection and uninstall isolation

**Choice:** Unmanaged `~/.omp/agent/skills/pipeline` without `.pipeline-installer-managed` uses the existing tree-host shadow policy (warn; TTY relocate/skip; non-TTY auto-relocate). Uninstall removes the managed skill tree and the installer-owned `commands/pipeline/` tree only. Sibling commands, project `.omp`, OpenCode, Claude, Codex, and Grok stay.

**Why:** Matches Claude/OpenCode tree hosts. Do not silently overwrite personal OMP skills.

### D10 — Class over site

**Choice:** This is a shared outer-host class: manifest + registry + installer `commandsKind` + captured `execPath`. The next session host does not need a new mole issue if it ships the same surfaces. Do not special-case only this box's OpenCode leftover file.

**Why:** Ship-path autonomy constitution. The observed OpenCode-template load is a missing-host class, not an OMP-only PATH bug.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| OMP TypeScript command layout drifts (`index.ts` vs `pipeline.ts`) | Pin the documented `<commands>/<name>/index.ts` layout in specs; tests assert the installed path and export shape without a live OMP TUI. |
| OpenCode `pipeline.md` still exists on the box | TS custom command runs first; specs forbid using that file as the OMP surface; do not require deleting OpenCode artifacts. |
| Captured `execPath` becomes stale after a Node upgrade | Install/update rewrites the command. #1236 re-exec still applies when the baked binary is below the engines floor. |
| Named OMP profiles ignore `~/.omp/agent` | Document that this installer owns only the default global root; named profiles are out of scope. |
| `--host all` skips OMP when `~/.omp/agent` is absent | Same as other tree hosts; `--host omp` creates the base. |
| Profile bootstrap pair is copied by `pipeline init` | #1240 already requires repo yml for execution; README states the profile is not live worker selection. |

## Migration Plan

1. Land overlay, manifest, installer, tests, and mirror on the feature branch.
2. Operators run `install --host omp` (or `update` / `--host all` when the OMP base exists).
3. Existing Claude/Codex/Grok/OpenCode installs stay.
4. Rollback: `uninstall --host omp` removes only OMP managed artifacts.

## Open Questions

1. Exact OMP `CustomCommandFactory` export fields (`name` / `handler` vs `run`) — confirm against current `@oh-my-pi/pi-coding-agent` types at implement time (golden rule: verify external shapes). The spec contract is: named `pipeline`, void-return, no LLM turn, captured execPath spawn.
2. Whether OMP requires a restart after writing `commands/pipeline/index.ts` — document whatever current OMP discovery does; do not invent a watcher.
