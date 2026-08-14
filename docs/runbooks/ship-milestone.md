# Ship milestone (Option 1 — Tugboat)

**Primary path for agent-box / Buzz:** the thin host composer
`examples/supervisor/shell/tugboat.sh`. It sequences existing Pipeline CLI verbs
plus wait and notify. It is not a second control plane and not in-engine
`pipeline ship`.

Phrase: **`Ship milestone vX.Y.Z`** → detach Tugboat for that milestone.  
Status: **`tugboat --milestone vX.Y.Z --status`** or read
`~/.local/state/pipeline-supervisor/ship-vX.Y.Z/state.json`.

Contract: [supervisor.md](../supervisor.md)  
Epic / hardening: #1001 / #927

## Ownership

| Concern | Owner |
|---|---|
| Train, merge policy, release, promote decisions | Pipeline CLI (`train`, `release`, `release finish`, `engine-promote`) |
| Phase sequence, wait CI / Release, failure detail, notify | **Tugboat** (host composer) |
| Detached process, logs, state dir | host (`nohup` + `PIPELINE_SUPERVISOR_STATE`) |
| Material progress during train (optional) | shared `ship-stage-watch.sh` + `material-filter.mjs` |
| Buzz delivery | shared `ship-notify.sh` (no-op without messenger env; best-effort with retry + audit) |

GitHub and Pipeline run state remain authoritative. Tugboat does not implement
a grant factory, durable outer ledger, or merge-from-advance.

## Install (Option 1 primary)

```bash
ROOT=/path/to/agent-pipeline
install -d -m 0755 "$HOME/.local/bin"
for f in tugboat ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${f}.sh" \
    "$HOME/.local/bin/$f"
done
install -m 0755 "$ROOT/examples/supervisor/shell/train-status-complete.py" \
  "$HOME/.local/bin/train-status-complete.py"
install -m 0755 "$ROOT/examples/supervisor/shell/release-checks-green.py" \
  "$HOME/.local/bin/release-checks-green.py"
```

Keep installed copies in sync with repo examples after `main` moves — host
files are not generated. Doctor check
`supervisor:tugboat-install-parity` fails closed when
`~/.local/bin/tugboat` is present but its content (or sibling
`release-checks-green.py` / `train-status-complete.py`) does not match the
repo examples under `examples/supervisor/shell/`. Marker-only forks are not
accepted. Refresh with the same `install` loop (includes **`ship-notify`** —
post-merge reinstall so hosts pick up delivery retry/audit changes).

Host env (mode-0600 profile):

```bash
export REPO_DIR=/path/to/control-checkout   # required
export PIPELINE=$HOME/.local/bin/pipeline   # required
export ALLOW_MERGE=1                        # required for mutating ship
# optional:
# export ENGINE_PROMOTE_HOST=all            # default all (codex/claude/grok/opencode)
# export PIPELINE_SUPERVISOR_STATE=$HOME/.local/state/pipeline-supervisor
# export PIPELINE_MATERIAL_FILTER=…/material-filter.mjs
```

## Operator usage

```bash
# Detach (Buzz: Ship milestone v1.37.0)
tugboat --milestone v1.37.0 --detach

# Serial multi-milestone (promote between; no parallel fat state machine)
tugboat --milestones v1.37.0 v1.38.0 --detach

# Status (no train/release/promote side effects)
tugboat --milestone v1.37.0 --status
```

State and logs:

```text
~/.local/state/pipeline-supervisor/ship-vX.Y.Z/
  state.json      # phase, status, detail (failure reasons enriched)
  playbook.log
  train.json / release-*.err / engine-promote.err …

~/.local/state/pipeline-supervisor/notify/   # shared ship-notify state
  <dedupe-key>    # TTL dedupe (epoch + content); not proof of remote delivery
  audit.log       # terminal send outcomes: ok / fail + attempts + reason
  failed/<id>     # supervisor-visible marker after exhausted retries
```

If the Buzz channel is quiet during a ship, check `notify/audit.log` and
`notify/failed/` under `PIPELINE_SUPERVISOR_STATE` before assuming the helper
never ran. Notify is still best-effort (exit 0 after failure); ship/train do
not block solely on messenger delivery. Reinstall `ship-notify` from
`examples/supervisor/shell/` after `main` moves (same install loop as Tugboat).

Issues on the milestone must be `pipeline:ready` before train dispatch.

### Phase sequence (fixed)

1. `pipeline train --milestone vX.Y.Z --merge --json` (complete gate + resume)
2. `pipeline release X.Y.Z --no-edit --skip-frg` (**bare** version — leading `v` is invalid)
3. Wait until open release PR checks are green (`gh pr checks --json name,state,bucket`)
4. `pipeline release finish <pr>`
5. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
6. `pipeline engine-promote --for X.Y.Z --host all --skip-frg` (or `ENGINE_PROMOTE_HOST` override)

Hardened behaviors (preserve):

| Item | Behavior |
|---|---|
| #989 | Promote defaults to **all** hosts when `ENGINE_PROMOTE_HOST` unset |
| #996 | Never call release-finish while checks are pending/failed |
| #997 | Failed phase notify/state includes blocker or err tail (not only `exit N`) |
| Idempotent | Existing open PR titled `release: X.Y.Z …` is reused |
| Thinness | No grant factory / `pipeline ship` product path inside Tugboat |

## FRG is not part of thin ship

Factory Reliability Gate is optional / advisory on this path (`--skip-frg` on
release and engine-promote). To run FRG deliberately, use `pipeline factory-gate`
or durable `factory-release prepare` outside Tugboat.

## Alternate / legacy paths (not primary Buzz)

### Chain playbook (`pipeline-ship-playbook.sh`)

Documented **alternate** composition for hosts that still install it. Same
general train → release → finish → promote idea. **Not** the Option 1 primary
Buzz path after #1001 / #927. If installed, keep promote default `:-all` and
pass doctor `supervisor:ship-playbook-promote-host` (#989).

```bash
install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" \
  "$HOME/.local/bin/pipeline-ship-playbook"
```

### Authorized `ship-milestone.sh` / in-engine `pipeline ship`

Parked / non-primary product surface (ship-auth issuer, grant-style admission).
Not required for Option 1 Buzz. Do not present it as the default
`Ship milestone vX.Y.Z` mapping on agent-box.

## Doctor

```bash
pipeline doctor
# Expect (when ~/.local/bin/tugboat is installed):
#   supervisor:tugboat-install-parity → pass
# When only legacy playbook is installed:
#   supervisor:ship-playbook-promote-host → pass (or fail with refresh remediation)
# Neither installed → both checks skip
```

## Exact-run progress (optional)

When Pipeline status returns an **exact** absolute `events.jsonl` path for a
run, optional progress posts may stream only that file through the installed
`material-filter.mjs` via `ship-stage-watch`:

```bash
ship-stage-watch \
  --events-file /absolute/path/from/status/events.jsonl \
  --label "ship v1.37.0"
```

Do not guess a path or select the most recently modified run. Notification
failure is observational and must not stop or advance a ship.

## Parked non-goals

- Auto-file ship failures onto the milestone
- Gateway/session heartbeat product tuning as a ship feature
- Grant factory / MessagingPort / Slack / ship-auth issuer (#966–#968, #973)
- Shared NL intent platform (#974 beyond phrase → argv)
- Option 2 in-engine ship as the Buzz primary path

Historical context: [session-2026-08-ship-factory-lessons.md](./session-2026-08-ship-factory-lessons.md).
