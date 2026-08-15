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

**Shim**:
A short host SKILL (or none) that tells the agent to exec `pipeline` on PATH.
_Avoid_: `/pipeline:*` command pack, marketplace command files

**Slash command**:
A generated `/pipeline:status`-style wrapper that only execs the CLI. Not required.
_Avoid_: product surface

**Plugin directory**:
The committed `plugin/` tree (core mirror + generated `/pipeline:*` files). Deleted in #1050. Claude install writes a short SKILL next to the CLI, not a repo `plugin/` package.
_Avoid_: marketplace listing, source of truth

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

**Playbook**:
A launcher that detaches a live ship. Not the ship.
_Avoid_: live-ship probe, second scheduler

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
Assembled reviewer input exceeds the harness ceiling. Fail-fast. Do not retry the same payload.
_Avoid_: transient timeout, unblock-and-rerun, shrink-the-1.29MB as this cut
