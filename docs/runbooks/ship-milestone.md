# Ship milestone (Option 1 — Tugboat)

**Primary path for agent-box / Buzz:** the thin host composer
`examples/supervisor/shell/tugboat.sh`. It sequences existing Pipeline CLI verbs
plus wait and notify. It is not a second control plane and not in-engine
`pipeline ship`.

Phrase: **`Ship milestone vX.Y.Z`** → detach Tugboat for that milestone.  
Status: **`tugboat --milestone vX.Y.Z --status`** (prefer over raw `state.json`;
status does not claim `running` from a dead pid alone — #1062).

**Live ship (#1062):** a second detach is refused only when a live process
cmdline is `train --merge` for that milestone, or the owning tugboat. Bare
`playbook.pid` + `kill -0`, per-issue `pipeline N` locks, and stale state alone
are **not** live ships — Ship still detaches once. Buzz and TUI paste share
that path (no paste detector).

**Concurrent Ship (#1111):** two overlapping `--detach` invocations for the
same repo + milestone serialize on a host-local flock at
`$PIPELINE_SUPERVISOR_STATE/admission/<repo-token>/vX.Y.Z.lock`. That lock
is not a live ship. The loser waits, then refuses with the live-ship probe
(`already running … not detaching a second copy`). Leftover lock files with
no live flock holder do not block a later Ship.

**`REPO_DIR`:** pin the live control checkout at tugboat start. Paths matching
`*factory-control*` are refused.

Contract: [supervisor.md](../supervisor.md)  
Epic / hardening: #1001 / #927 / #1062

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
export REPO_DIR=/path/to/control-checkout   # required; not *factory-control* (#1062)
export PIPELINE=$HOME/.local/bin/pipeline   # required
export ALLOW_MERGE=1                        # required for mutating ship
# Tugboat and the host pipeline launcher export AGENT_PIPELINE_PRODUCTION_PIN
# when unset to $REPO_DIR/.agent-pipeline/production-engine-pin.json so
# engine-promote and the next train doctor share one pin file (#1127).
# optional:
# export AGENT_PIPELINE_PRODUCTION_PIN=/path/to/production-engine-pin.json
# export ENGINE_PROMOTE_HOST=all            # default all (codex/claude/grok/opencode)
# export PIPELINE_SUPERVISOR_STATE=$HOME/.local/state/pipeline-supervisor
# export PIPELINE_MATERIAL_FILTER=…/material-filter.mjs
# export TUGBOAT_SKIP_FRG=1                 # escape only; requires TUGBOAT_SKIP_FRG_REASON
# export TUGBOAT_SKIP_FRG_REASON="…"
# export TUGBOAT_BASE_BRANCH=main           # optional override; default is
#                                          # .github/pipeline.yml base_branch.
#                                          # Required when that file is absent.
#                                          # origin/HEAD is not used.
```

## Operator usage

```bash
# Detach (Buzz: Ship milestone v1.37.0)
tugboat --milestone v1.37.0 --detach

# Serial multi-milestone (promote between; no parallel fat state machine)
tugboat --milestones v1.37.0 v1.38.0 --detach

# Status (no train/FRG pack/release/promote side effects)
tugboat --milestone v1.37.0 --status

# Operator escape only (requires a logged reason):
# tugboat --milestone v1.37.0 --skip-frg --skip-frg-reason "hotfix without pack"
```

State and logs:

```text
~/.local/state/pipeline-supervisor/ship-vX.Y.Z/
  state.json      # phase, status, detail (failure reasons enriched)
  playbook.log
  train.json / release-*.err / engine-promote.err …

~/.local/state/pipeline-supervisor/admission/<repo-token>/
  vX.Y.Z.lock     # flock for concurrent --detach (not a live-ship probe)

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
2. FRG pack: `pipeline factory-release prepare --request <abs.json> --json` (re-invoke until pack-done)
3. `pipeline release X.Y.Z --no-edit` (**bare** version — leading `v` is invalid; **no** `--skip-frg`)
4. Wait until open release PR checks are green (`gh pr checks --json name,state,bucket,link`). A first flake-eligible `test` fail requests `gh run rerun --failed` once, then waits again. Non-test product fails STOP. After merge, refresh installed Tugboat and `release-checks-green.py` from `examples/supervisor/shell/`.
5. `pipeline release finish <pr>`
6. Wait until GitHub Release `vX.Y.Z` is published (non-draft)
7. `pipeline engine-promote --for X.Y.Z --host all` (or `ENGINE_PROMOTE_HOST` override; **no** `--skip-frg`)

Hardened behaviors (preserve):

| Item | Behavior |
|---|---|
| #989 | Promote defaults to **all** hosts when `ENGINE_PROMOTE_HOST` unset |
| #996 | Never call release-finish while checks are pending/failed |
| #997 | Failed phase notify/state includes blocker or err tail (not only `exit N`) |
| Idempotent | Existing open PR titled `release: X.Y.Z …` is reused |
| Thinness | No grant factory / `pipeline ship` product path inside Tugboat |

## FRG pack is part of thin ship

Default Tugboat sequence is train → FRG pack → release (no `--skip-frg`) →
finish → promote. The pack phase composes
`pipeline factory-release prepare --request <abs.json> --json` and re-invokes
the same request until pack-done (`awaiting_frg_attestation`, this version
`latest.json` `pass: true`, or `complete` with an open release PR) or pack-fail.
A failed or missing pack stops the ship **before** `pipeline release`.

`--skip-frg` / `TUGBOAT_SKIP_FRG=1` is an operator escape only. It requires a
non-empty `--skip-frg-reason` / `TUGBOAT_SKIP_FRG_REASON`. Missing reason fails
closed and does not skip. A valid escape omits the pack phase, passes
`--skip-frg` to release and promote, and writes the reason into ship state or
log. A skip promote writes `frg_run_id` `no-frg-<X.Y.Z>` and
`frg_evidence_path` null. That pin is not production-quality. Default promote
requires a real FRG `run_id` and evidence path.

## Alternate / legacy paths (not primary Buzz)

### Chain playbook (`pipeline-ship-playbook.sh`)

Documented **alternate** composition for hosts that still install it. Same
general train → release → finish → promote idea. **Not** the Option 1 primary
Buzz path after #1001 / #927. If installed, keep promote default `:-all` and
pass doctor `supervisor:ship-playbook-promote-host` (#989).

```bash
install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" \
  "$HOME/.local/bin/pipeline-ship-playbook"
install -m 0644 "$ROOT/examples/supervisor/shell/frg-pack-helpers.sh" \
  "$HOME/.local/bin/frg-pack-helpers.sh"
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
