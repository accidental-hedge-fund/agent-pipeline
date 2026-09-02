---
name: pipeline-supervisor
description: >
  Thin Hermes skill for the private pipeline-factory Buzz channel.
  Maps operator messages to the agent-pipeline CLI. Phrase Ship milestone
  vX.Y.Z execs pipeline ship --milestone. Does not use the removed
  hermes-factory grant wrapper.
---

# Pipeline supervisor (Hermes production)

Use this skill only in the private **pipeline-factory** Buzz channel, via
`/pipeline-supervisor` (or your host’s equivalent skill invocation).

Read the contract: [docs/supervisor.md](../../../docs/supervisor.md).  
Ship runbook: [docs/runbooks/ship-milestone.md](../../../docs/runbooks/ship-milestone.md).

## Absolute rules

1. Call only the installed **pipeline** CLI (and leftover thin detach helpers).
   Phrase `Ship milestone vX.Y.Z` execs `pipeline ship --milestone vX.Y.Z`.
   Never call `~/.local/lib/hermes-factory/factory.mjs` — that pilot is retired.
   Never invent a grant factory or second ship brain. Tugboat is not the owner.
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
| `AGENT_PIPELINE_PRODUCTION_PIN` | One live factory pin. Leave unset so Tugboat and the host `pipeline` launcher export `$REPO_DIR/.agent-pipeline/production-engine-pin.json`. Do not default a second path. Do not overwrite an operator value. |
| `PIPELINE` | Absolute launcher, e.g. `node …/pipeline.mjs` — **required** |
| `ALLOW_MERGE` | `1` only if this channel may run `train --merge` / release finish — **required for ship** |
| `AGENT_PIPELINE_ROOT` | Clone of agent-pipeline containing `examples/supervisor/shell/` |
| `PIPELINE_MATERIAL_FILTER` | Optional override. Tugboat presents the pin/host install-tree `material-filter.mjs` at watch spawn when unset. |
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

### Ship milestone (in-engine `pipeline ship`)

Operator phrase: **`Ship milestone vX.Y.Z`** (case-insensitive variants OK).

Map to **`pipeline ship --milestone vX.Y.Z`**. Detach if the CLI is blocking.
Do **not** start Tugboat as the ship owner. Tugboat may remain a thin
notify/detach adapter only.

```bash
export REPO_DIR PIPELINE ALLOW_MERGE
nohup "$PIPELINE" ship --milestone vX.Y.Z --json \
  >"$HOME/.local/state/pipeline-supervisor/ship-vX.Y.Z.log" 2>&1 &
echo "started pipeline ship --milestone vX.Y.Z pid $!"
```

Status (no side effect — does not start train/release/promote):

```bash
"$PIPELINE" ship status --milestone vX.Y.Z --json
```

Read the Pipeline ship ledger. Do not treat Tugboat `ship-vX.Y.Z/state.json`
as the product status surface.

Default sequence is train `--merge` → FRG pack → release (no `--skip-frg`) →
wait CI green → `release finish` → `release ensure-tag` → wait GitHub Release →
`engine-promote`. `--skip-frg` is an operator escape with a logged reason, not
the default. Finish does not tag. Candidate `release ensure-tag` owns `vX.Y.Z`
from on-disk HMAC `latest.json` when FRG is gitignored.

FRG pack unsets `PIPELINE_FRG_ATTESTATION_KEY` and
`PIPELINE_FRG_ATTESTATION_KEY_FILE` in the `factory-release prepare` child.
When prepare returns `awaiting_frg_attestation`, the composer runs
`pipeline factory-gate --for X.Y.Z --from-run <loop>` in a separate
credentialed process (inherit `KEY`, or present `KEY_FILE` as `KEY`).
Candidate `release ensure-tag` uses the same credential recipe. Pack-done is
bound `latest.json` `pass: true` (or `complete` with an open release PR).
Unsigned wait is not pack-done.

On notify of a **non-human** failure, re-invoke the same
`pipeline ship --milestone vX.Y.Z` argv only. Do **not** classify, delete a
run directory, wait a cooldown, or invent `pipeline single` / `pipeline loop`.
If `pipeline ship status` reports human authority, stop and report that state.

### Release (manual steps — rarely needed when Tugboat runs)

```bash
# Prepare only (opens PR; never merges)
"$PIPELINE" release <X.Y.Z> --no-edit

# Finish: merge the open release PR (never tags)
"$PIPELINE" release finish <pr> --json

# Ship-end tag from on-disk HMAC latest.json (candidate engine)
"$PIPELINE" release ensure-tag <X.Y.Z> <mergeCommitOid> --packed-candidate <40-hex>

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

The watcher uses the shared material filter and exits on the bound file's
identity-terminal (`loop_run_superseded` / `loop_run_complete` /
`loop_run_stopped`, or ship_phase complete). Tugboat re-binds `--events-file`
from a later train stderr `loop_run_handoff`. If status has no exact event
path, report typed status and do not guess one. Do not glob latest runs.

## Operator message → intent

| Message | Action |
|---|---|
| `status 874` / `status` | `pipeline status` / doctor summary |
| `single 874` / `do #874` | background `pipeline single 874` (+ optional stage-watch `--issue`) |
| `train milestone vX.Y.Z` | `run-intent.sh 'train milestone vX.Y.Z'` |
| `train issues 1 2 3` | `run-intent.sh 'train issues 1,2,3'` |
| same + `and merge` | only if `ALLOW_MERGE=1` |
| `Ship milestone vX.Y.Z` / `ship milestone vX.Y.Z` | `pipeline ship --milestone vX.Y.Z` (detach if blocking) if `ALLOW_MERGE=1`. **Never** `pipeline single` / `pipeline loop` during ship (#1063). Train `--merge` is serial: merge-first R2D, STOP on block, do not start the next sibling. |
| `ship status vX.Y.Z` / `Ship status vX.Y.Z` | `pipeline ship status --milestone vX.Y.Z` (Pipeline ledger only) |
| `release prepare 1.34.0` | `pipeline release 1.34.0 --no-edit` |
| `release finish 123` | `pipeline release finish 123` if `ALLOW_MERGE=1` |
| `stop` | stop the detached tugboat/ship process for that milestone if known; do not invent rollback |

## Liveness (reattach, not retry)

A dead worker or interrupted follow is non-terminal. It is not human authority.

```bash
"$PIPELINE" liveness status --json
"$PIPELINE" liveness restore --json
"$PIPELINE" logs <run-id> --events --follow
"$PIPELINE" loop logs <loop-run-id> --events --follow
```

Do not classify a dead worker. Do not retry `pipeline single` because follow stopped. Do not merge from follow.

## What this skill is not

- Not the removed grant-envelope factory under `ops/hermes-factory`
- Not a durable outer ledger — GitHub + pipeline run state are truth
- Not a Tugboat-owned ship state machine — Tugboat is not the product owner
- Not MessagingPort / ship-auth issuer product work (#966–#968, #973)
- Not a second merge policy — only `ALLOW_MERGE=1` + Pipeline CLI verbs
