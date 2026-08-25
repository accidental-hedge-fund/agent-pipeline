# Agent Pipeline

The CLI that advances GitHub issues through a label-driven pipeline. Hosts wrap that CLI. They are not a second engine.

## Language

### Packaging

**CLI**:
The `pipeline` binary. The product. Every verb (`single`, `train`, `merge`, `status`) lands here.
_Avoid_: plugin engine, skill engine, core copy

**Host**:
A thin argv or JSON wrapper that invokes the CLI (Claude, Codex, Grok, OpenCode, OMP, Tugboat).
_Avoid_: second pipeline, per-host stage machine

**Outer-host ID**:
The install and lifecycle identity for a session surface (for example, `omp`). It is independent of a stage-adapter ID; `omp` does not replace or alias the `pi` adapter.
_Avoid_: provider identity, implementer identity

**Native host command**:
A host-owned command that invokes the installed launcher as a process, forwarding the session working directory and exact argv. It does not turn command output into an LLM prompt. OMP's `/pipeline` uses this form.
_Avoid_: prompt template, a second CLI, OpenCode command reuse

**Shim**:
A short host SKILL (or none) that tells the agent to exec `pipeline` on PATH.
_Avoid_: `/pipeline:*` command pack, marketplace command files

**Slash command**:
A generated `/pipeline:status`-style wrapper that only execs the CLI. Not required.
_Avoid_: product surface

**Plugin directory**:
The committed `plugin/` tree (core mirror + generated `/pipeline:*` files). Deleted in #1050. Claude install writes a short SKILL next to the CLI, not a repo `plugin/` package.
_Avoid_: marketplace listing, source of truth

**Launcher bootstrap**:
The dependency-free phase before loading TypeScript. It may answer version-only requests on its invoking Node; otherwise it resolves and re-execs an engines-compliant Node with the resolved binary's directory first on `PATH`.
_Avoid_: treating PATH `node` as the engine, a per-host Node walker

**Introspection compatibility**:
Version-only launcher behavior available below the engine floor. It does not make that Node version a supported TypeScript runtime.
_Avoid_: lowering `engines.node`, Node 22 engine support

**Repository execution policy**:
A runnable target has `.github/pipeline.yml` with both `harnesses.implementer` and `harnesses.reviewer`. That file selects stage workers; an outer host does not. Missing or partial policy fails before work begins.
_Avoid_: host-selected workers, profile fallback for a runnable repository

**Profile bootstrap**:
Compatibility metadata supplied before repository configuration is read. An OMP profile keeps the current launcher/config interface intact; it must not determine live stage workers once repository execution policy is required.
_Avoid_: treating a host profile as repository policy

**Captured launcher executable**:
The absolute `process.execPath` used to install a native host command. The command launches the installed shim with that executable and no shell/PATH `node` lookup; launcher bootstrap may still re-exec a compliant Node.
_Avoid_: a hard-coded `node` command, a second resolver

**OPERATION_SURFACE**:
The single list of CLI verbs in `scripts/build.mjs`. Catalog for docs and the SKILL verb table. Does not justify emitting one markdown file per verb.

**MCP server**:
A possible third surface that would wrap the same CLI verbs as tools. Not required. Parked (#907).
_Avoid_: control plane, startup requirement

**Implementer**:
The configured harness that plans, codes, and fixes (`harnesses.implementer`). A role, not a brand.
_Avoid_: Claude, Grok (as the name of the role)

**Reviewer**:
The configured independent harness that judges plans and diffs (`harnesses.reviewer`). A role, not a brand.
_Avoid_: Codex (as the name of the role), self-review as the default product

### Ship path

**Live ship**:
A detached `pipeline train --merge` for one milestone. That process is the ship.
_Avoid_: Buzz thread as the ship, playbook as the definition, `pipeline 702` / `single` lock as a live ship

**Live-ship probe**:
A live pid whose cmdline is that `train --merge` (or the tugboat that owns it). Only this may refuse a second detach.
_Avoid_: `playbook.pid` + `kill -0`, any issue lock

**Playbook**:
A launcher that detaches a live ship. Not the ship. Same detach path for Buzz and a TUI paste: live ship exists → status + notify; else detach once.
_Avoid_: live-ship probe, paste detector, second scheduler

**Ship origin**:
`REPO_DIR` resolved once at tugboat start from install/env. Paths matching `*factory-control*` are refused. Later session text cannot retarget.
_Avoid_: `env.example` factory-control default, mid-ship model override

**STOP**:
`train --merge` will not implement or merge another sibling.
_Avoid_: park, blocked (as synonyms)

**Park**:
The item is at `pipeline:needs-human`.
_Avoid_: STOP, blocked

**Blocked**:
The item carries `blocked` (CI exhausted, etc.). Serial `--merge` STOPs on park or blocked. `pipeline loop` may still wave.
_Avoid_: parked, needs-human

**Hard wait**:
`Depends on: #N` or `blocked by #N` whose target is an open issue on this train selector. Only this may deadlock or hold the train.
_Avoid_: any `#N` under `## Dependencies`, Related, see-also, later-milestone prose

**Ignored dep**:
A `#N` that is closed, off-milestone, or not hard-wait grammar. Logged, not a wait.
_Avoid_: operator rewrite of the issue body

**Intake-ready**:
`pipeline:ready` — the issue may be picked up. Not finished.
_Avoid_: ready-to-deploy, done because a PR exists

**Ready-to-deploy**:
`pipeline:ready-to-deploy` — advance is finished. Merge is a separate authorized verb.
_Avoid_: `pipeline:ready`, `ready_label_present` meaning this label

**Advance-eligible**:
Not ready-to-deploy, and work remains (including an open PR in `pr_opened`). Dispatch is advance.
_Avoid_: supervisor_no_progress when `next_actions` is advance

**Docs-stale**:
`generate-docs --check` failed on generator-owned files. Regen-able. Not unknown CI.
_Avoid_: unknown, assertion, flake re-run

**Review-prompt-too-large**:
Assembled reviewer prompt (after `buildReview*Prompt`, before spawn) exceeds the configured reviewer’s declared max, else Codex `1048576`. `setBlocked`. Do not retry the same payload. Review-1 and review-2.
_Avoid_: transient timeout, skip-review-and-advance, shrink-the-1.29MB as this cut, per-model table this cut
