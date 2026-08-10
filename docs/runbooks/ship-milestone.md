# Ship milestone runbook

Durable **train → release → wait → engine-promote** for a versioned GitHub
milestone, using only the public Pipeline CLI. The shell playbook under
`examples/supervisor/shell/` is a **host-side example**, not a second product
control plane.

Contract: [supervisor.md](../supervisor.md)  
FRG: [frg-pack-checklist.md](./frg-pack-checklist.md),  
[factory-reliability-gate-runbook.md](../factory-reliability-gate-runbook.md)

## What it does

| Phase | Command | Notes |
|---|---|---|
| Train + integrate | `pipeline train --milestone vX.Y.Z --merge --json` | Requires `ALLOW_MERGE=1` |
| Release prepare | `pipeline release X.Y.Z --no-edit` | Requires FRG `latest.json` |
| Release finish | `pipeline release finish <pr> --json` | Merges release PR only; never tags |
| Wait | `gh release view vX.Y.Z` | Poll until published (not draft) |
| Promote | `pipeline engine-promote --for X.Y.Z --host …` | Pin + install after Release |

Multi-milestone: **strictly serial**. Each milestone completes full ship
(including promote) before the next starts.

## Install examples on a host

```bash
ROOT=/path/to/agent-pipeline   # clone containing examples/
install -d -m 0755 "$HOME/.local/bin"
for s in ship-milestone ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${s}.sh" \
    "$HOME/.local/bin/${s//-/_}" 2>/dev/null || true
  # Prefer stable names:
  install -m 0755 "$ROOT/examples/supervisor/shell/${s}.sh" \
    "$HOME/.local/bin/$s"
done
# Optional: alias pipeline → pipeline-launcher
# ln -sf "$HOME/.local/bin/pipeline-launcher" "$HOME/.local/bin/pipeline"
```

Set env (mode 0600 file, never commit secrets):

```bash
export REPO_DIR=/path/to/control-checkout
export PIPELINE=pipeline          # or absolute node …/pipeline.mjs
export ALLOW_MERGE=1              # only on allowlisted private channel
export PIPELINE_SUPERVISOR_STATE=$HOME/.local/state/pipeline-supervisor
export SHIP_NOTIFY=1
export SHIP_NOTIFY_HEARTBEAT_S=0  # stage-watch posts stage lines; heartbeats off
# Optional Buzz:
# export BUZZ_BIN=… BUZZ_RELAY_URL=… BUZZ_CHANNEL=… BUZZ_CREDENTIALS_FILE=…
```

## Operator commands

```bash
# Foreground
ship-milestone --milestone v1.34.0

# Background + durable state under PIPELINE_SUPERVISOR_STATE/ship-v1.34.0/
ship-milestone --milestone v1.34.0 --detach
ship-milestone --milestone v1.34.0 --status

# Serial multi (promote between)
ship-milestone --milestones v1.34.0 v1.35.0 --detach
```

## Proactive status (Buzz / chat)

| Tool | Role |
|---|---|
| `ship-notify` | Thin messenger post; **no-op** without Buzz env |
| `ship-stage-watch` | Poll loop/advance events; post **stage transitions** only |
| Phase heartbeats | Off by default (`SHIP_NOTIFY_HEARTBEAT_S=0`) |

Stage-watch filters (do **not** rebroadcast unrelated history under a ship label):

- **Since watermark:** only events at/after process start (or `--since`);
  pre-ship loop/FRG history is ignored even when `seen-keys` is empty.
- **Issue scope:** `--issue N`, or for milestones the `ordered_issues` from
  `train.json` (`--issues-file`) once train writes it.
- Drop `#None` / `#null`; skip stale precondition exclusions once an issue
  later advances within the scoped set.

Prefer stage posts over generic “still running” heartbeats.

For a **single** issue advance, supervisors can start stage-watch with
`--issue N` while `pipeline single N` runs — same since/filter rules.

**Incident + architecture write-up (2026-08 ship session):**
[session-2026-08-ship-factory-lessons.md](./session-2026-08-ship-factory-lessons.md).

## FRG hard stop

If `.agent-pipeline/frg/<version>/latest.json` is missing, the playbook
**stops after train** with a clear notify. Do not invent FRG artifacts.
Use the FRG pack checklist, then re-run or resume:

```bash
# Resume after FRG lands (empty milestone / prior complete train is OK)
ship-milestone --milestone v1.34.0 --detach
```

## Resume / crash safety

- Empty milestone (“no open issues”) → train treated as already complete
- Prior `train_status.complete=true` in run dir → resume past train
- Mid-edit of a **running** script file can crash bash (ill/syntax); do not
  overwrite live playbook processes — restart after deploy of new scripts

## What this is not

- Not auto-merge in `.github/pipeline.yml`
- Not a grant factory or second scheduler
- Not authorization — host `gh` + `ALLOW_MERGE` policy are the boundary
