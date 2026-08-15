---
name: pipeline-supervisor
description: >
  Thin Hermes skill for the private pipeline-factory Buzz channel.
  Maps operator messages to the agent-pipeline CLI and Option 1 Tugboat ship.
  Does not use the removed hermes-factory grant wrapper.
---

# Pipeline supervisor (Hermes production)

Use this skill only in the private **pipeline-factory** Buzz channel, via
`/pipeline-supervisor` (or your host’s equivalent skill invocation).

Read the contract: [docs/supervisor.md](../../../docs/supervisor.md).  
Ship runbook: [docs/runbooks/ship-milestone.md](../../../docs/runbooks/ship-milestone.md).

## Absolute rules

1. Call only the installed **pipeline** CLI, `run-intent.sh`, or **Tugboat**
   for ship. Never call `~/.local/lib/hermes-factory/factory.mjs` — that pilot
   is retired. Never invent a grant factory or second ship brain.
2. Do **not** invent models, effort, stage labels, or a second state machine.
3. Do **not** default to merge. Only pass merge when the operator is explicit
   **and** `ALLOW_MERGE=1` is set in the host environment.
4. Prefer **non-blocking** long runs: detach ship / train and report how to
   check status. Do not block the chat tool for hours.
5. Never paste secrets, credential paths’ contents, or full harness logs into Buzz.
6. Option 1 ship does **not** require a signed authorization file. Do not block
   on ship-auth issuer tooling for `Ship milestone vX.Y.Z`.
7. Do not discover “latest” event directories. Observe only an exact event path
   returned by Pipeline status when using stage-watch.

## Environment (host)

Expect these on the Hermes process PATH / env (set by the deployment profile):

| Variable | Purpose |
|---|---|
| `REPO_DIR` | Live control checkout (e.g. `ap-main-control`) — **required for ship**. Tugboat pins this at start and **refuses** `*factory-control*` (#1062). |
| `PIPELINE` | Absolute launcher, e.g. `node …/pipeline.mjs` — **required** |
| `ALLOW_MERGE` | `1` only if this channel may run `train --merge` / release finish — **required for ship** |
| `AGENT_PIPELINE_ROOT` | Clone of agent-pipeline containing `examples/supervisor/shell/` |
| `PIPELINE_MATERIAL_FILTER` | Installed `material-filter.mjs` used for exact-run progress |
| `ENGINE_PROMOTE_HOST` | Optional; default `all` (do not force codex-only) |

## Commands

### Status (read-only)

```bash
# Single issue
"$PIPELINE" status <N> --json

# Or doctor in the service env
"$PIPELINE" doctor --json
```

### Single issue (no merge)

```bash
cd "$REPO_DIR"
nohup "$PIPELINE" single <N> >"$HOME/.local/state/pipeline-supervisor/single-<N>.log" 2>&1 &
echo "started single <N> pid $!"
```

### Train (milestone or issues)

Prefer the portable wrapper:

```bash
export REPO_DIR PIPELINE ALLOW_MERGE
"$AGENT_PIPELINE_ROOT/examples/supervisor/shell/run-intent.sh" "train milestone v1.34.0"
# or: "train issues 905,874,870"
# merge only when operator said so AND ALLOW_MERGE=1:
# "$AGENT_PIPELINE_ROOT/examples/supervisor/shell/run-intent.sh" "train milestone v1.34.0 and merge"
```

For long trains, wrap with `nohup` / systemd-run and post the log path.

### Ship milestone (Option 1 — Tugboat primary)

Operator phrase: **`Ship milestone vX.Y.Z`** (case-insensitive variants OK).

Map to **Tugboat only** — not `pipeline-ship-playbook` as primary, not
`ship-milestone.sh` / authorized `pipeline ship` as the Option 1 default.

```bash
export REPO_DIR PIPELINE ALLOW_MERGE
# Prefer installed binary (refresh from repo examples after engine promote):
tugboat --milestone vX.Y.Z --detach
# Or versioned source:
# "$AGENT_PIPELINE_ROOT/examples/supervisor/shell/tugboat.sh" --milestone vX.Y.Z --detach
```

**Live ship (#1062):** Tugboat refuses a second detach only when a live process
cmdline is `train --merge` for that milestone (or the owning tugboat). A bare
`playbook.pid` / `kill -0`, a per-issue `pipeline N` lock, or stale `state.json`
alone is **not** a live ship — still detach once. Buzz and TUI paste share this
path; do not invent a paste detector. Second Ship while live → status + notify,
no stack.

Status (no side effect — does not start train/release/promote). Does **not**
claim `running` from a dead pid alone:

```bash
tugboat --milestone vX.Y.Z --status
# Prefer this over raw state.json (status rewrites stale "running")
```

State/logs: `~/.local/state/pipeline-supervisor/ship-vX.Y.Z/`.

Tugboat composes: train → release (bare version) → wait CI green → release
finish → wait GitHub Release → `engine-promote --host all`. Failure lines
include phase reason (blocker / err tail). Do not reimplement those phases in
Hermes.

### Release (manual steps — rarely needed when Tugboat runs)

```bash
# Prepare only (opens PR; never merges)
"$PIPELINE" release <X.Y.Z> --no-edit

# Finish: merge the open release PR (never tags — GitHub workflows tag)
"$PIPELINE" release finish <pr> --json

# After the published GitHub Release exists: pin + install (all hosts default)
cd "$REPO_DIR"
"$PIPELINE" engine-promote --for <X.Y.Z> --host all --json
```

### Exact-run material posts

```bash
# Only when typed status returns an exact absolute events_file:
"$AGENT_PIPELINE_ROOT/examples/supervisor/shell/ship-stage-watch.sh" \
  --events-file "$EXACT_EVENTS_FILE" --label "ship vX.Y.Z"
```

The watcher uses the shared material filter. If status has no exact event path,
report typed status and do not guess one.

## Operator message → intent

| Message | Action |
|---|---|
| `status 874` / `status` | `pipeline status` / doctor summary |
| `single 874` / `do #874` | background `pipeline single 874` (+ optional stage-watch `--issue`) |
| `train milestone vX.Y.Z` | `run-intent.sh 'train milestone vX.Y.Z'` |
| `train issues 1 2 3` | `run-intent.sh 'train issues 1,2,3'` |
| same + `and merge` | only if `ALLOW_MERGE=1` |
| `Ship milestone vX.Y.Z` / `ship milestone vX.Y.Z` | **Tugboat** `--milestone vX.Y.Z --detach` if `ALLOW_MERGE=1`. **Never** `pipeline single` / `pipeline loop` during ship (#1063). Train `--merge` is serial: STOP on block, do not start the next sibling. |
| `ship status vX.Y.Z` / `Ship status vX.Y.Z` | **Tugboat** `--milestone vX.Y.Z --status` (state only) |
| `release prepare 1.34.0` | `pipeline release 1.34.0 --no-edit` |
| `release finish 123` | `pipeline release finish 123` if `ALLOW_MERGE=1` |
| `stop` | stop the detached tugboat/ship process for that milestone if known; do not invent rollback |

## What this skill is not

- Not the removed grant-envelope factory under `ops/hermes-factory`
- Not a durable outer ledger — GitHub + pipeline run state are truth
- Not Option 2 in-engine `pipeline ship` as the Buzz primary path (parked)
- Not MessagingPort / ship-auth issuer product work (#966–#968, #973)
- Not a second merge policy — only `ALLOW_MERGE=1` + Pipeline CLI verbs
