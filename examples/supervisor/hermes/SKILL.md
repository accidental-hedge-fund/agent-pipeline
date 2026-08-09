---
name: pipeline-supervisor
description: >
  Thin Hermes skill for the private pipeline-factory Buzz channel.
  Maps operator messages to the agent-pipeline CLI (train / single / status).
  Does not use the removed hermes-factory grant wrapper.
---

# Pipeline supervisor (Hermes production)

Use this skill only in the private **pipeline-factory** Buzz channel, via
`/pipeline-supervisor` (or your host’s equivalent skill invocation).

Read the contract: [docs/supervisor.md](../../../docs/supervisor.md).

## Absolute rules

1. Call only the installed **pipeline** CLI (or `run-intent.sh`). Never call
   `~/.local/lib/hermes-factory/factory.mjs` — that pilot is retired.
2. Do **not** invent models, effort, stage labels, or a second state machine.
3. Do **not** default to merge. Only pass merge when the operator is explicit
   **and** `ALLOW_MERGE=1` is set in the host environment.
4. Prefer **non-blocking** long runs: start train in the background and report
   the command line + how to check status. Do not block the chat tool for hours.
5. Never paste secrets, credential paths’ contents, or full harness logs into Buzz.

## Environment (host)

Expect these on the Hermes process PATH / env (set by the deployment profile):

| Variable | Purpose |
|---|---|
| `REPO_DIR` | Target checkout (e.g. factory control clone) |
| `PIPELINE` | Absolute launcher, e.g. `node …/pipeline.mjs` |
| `ALLOW_MERGE` | `1` only if this channel may run `train --merge` / `release finish` |
| `AGENT_PIPELINE_ROOT` | Clone of agent-pipeline containing `examples/supervisor/shell/` |

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

### Release (after train / FRG)

```bash
# Prepare only (opens PR; never merges)
"$PIPELINE" release <X.Y.Z> --no-edit

# Finish: merge the open release PR (never tags — GitHub workflows tag)
"$PIPELINE" release finish <pr> --json
```

## Operator message → intent

| Message | Action |
|---|---|
| `status 874` / `status` | `pipeline status` / doctor summary |
| `single 874` / `do #874` | background `pipeline single 874` |
| `train milestone vX.Y.Z` | `run-intent.sh 'train milestone vX.Y.Z'` |
| `train issues 1 2 3` | `run-intent.sh 'train issues 1,2,3'` |
| same + `and merge` | only if `ALLOW_MERGE=1` |
| `release prepare 1.34.0` | `pipeline release 1.34.0 --no-edit` |
| `release finish 123` | `pipeline release finish 123` if `ALLOW_MERGE=1` |
| `stop` | do not force-merge; tell operator how to kill the logged pid / unit |

## What this skill is not

- Not the removed grant-envelope factory under `ops/hermes-factory`
- Not authorization by itself — `gh` on this host is the GitHub authority
- Not a durable outer ledger — GitHub + pipeline run state are truth
