# Ship milestone host adapter

Use the thin adapter in `examples/supervisor/shell/ship-milestone.sh` to submit
one authorized request to the Pipeline-owned ship coordinator. The host does
not sequence train, recovery, FRG, release, publication, or engine promotion.

Contract: [supervisor.md](../supervisor.md)

## Ownership

| Concern | Owner |
|---|---|
| Ship lifecycle, retry, reconciliation, and durable status | `pipeline ship` |
| Detached process, restart, logs, and stop | user systemd |
| Authenticated command admission | the host deployment |
| Material progress selection | installed `material-filter.mjs` |
| Buzz delivery | `ship-notify.sh` |

GitHub and Pipeline run state remain authoritative. The host does not maintain
a playbook ledger, infer a release PR, poll GitHub Releases, or search for the
latest loop run.

## Install

```bash
ROOT=/path/to/agent-pipeline
install -d -m 0755 "$HOME/.local/bin"
for script in ship-milestone ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${script}.sh" \
    "$HOME/.local/bin/$script"
done
```

Set host configuration in a mode-0600 environment file:

```bash
export REPO_DIR=/path/to/control-checkout
export PIPELINE=$HOME/.local/bin/pipeline
export ALLOW_MERGE=1
export PIPELINE_MATERIAL_FILTER=$HOME/.codex/skills/pipeline/scripts/material-filter.mjs
export PIPELINE_SHIP_AUTH_PUBLIC_KEY_FILE=/etc/agent-pipeline/ship-authority.pem
```

`PIPELINE` must name one executable. Use `pipeline-launcher.sh` when the
installed command otherwise needs several shell words.

## Submit and inspect one ship

The authorization path must be absolute. The authorization must come from the
deployment's authenticated, immutable, expiring command-admission path for the
exact repository, base, milestone, and version. Hermes must never compose or
edit this file from free-form chat text.

The trusted ingress writes one mode-0600 JSON object with these exact fields:

```json
{
  "schema_version": 1,
  "kind": "ship_authorization",
  "event_id": "<64 lowercase hex characters>",
  "sender_id": "<authenticated sender identity>",
  "channel_id": "<authenticated channel identity>",
  "thread_id": "<authenticated thread identity>",
  "repository": "owner/name",
  "base_branch": "main",
  "milestone": "v1.34.0",
  "version": "1.34.0",
  "issued_at": "2026-08-10T12:00:00.000Z",
  "expires_at": "2026-08-17T12:00:00.000Z",
  "actions": [
    "train_merge",
    "frg",
    "release_prepare",
    "release_finish",
    "engine_promote"
  ],
  "fingerprint": "<lowercase SHA-256>",
  "signature": "<base64 Ed25519 signature>"
}
```

The fingerprint is SHA-256 over the compact JSON object in the field order
shown above through `actions`, excluding `fingerprint` and `signature`. The
gateway signs that same compact object with Ed25519. Pipeline verifies the
signature against `PIPELINE_SHIP_AUTH_PUBLIC_KEY_FILE`. Provision that public
key as a root-owned regular file that is not group- or world-writable. The
trusted ingress must still verify the Buzz transport signature, sender,
channel, and thread before it signs the authorization. Pipeline does not add a
second Buzz client or keep the signing private key on the factory host.

```bash
ship-milestone \
  --milestone v1.34.0 \
  --for 1.34.0 \
  --authorization /run/user/1000/pipeline-authority/<event-id>.json \
  --detach

ship-milestone --milestone v1.34.0 --for 1.34.0 --status
```

For a `vX.Y.Z` milestone, `--for` can be omitted. `--detach` submits a stable
repo-scoped `pipeline-ship-…` transient user unit with
`systemd-run --user --collect` and
returns after admission. The unit restarts only after abnormal process
termination, with a three-start-per-minute limit. Typed application failures do
not create an outer retry loop. The same Pipeline coordinates reconcile durable
state. The adapter does not use `nohup`, PID
files, shell locks, or a second state file.

Use systemd for process operations:

```bash
systemctl --user list-units 'pipeline-ship-*'
systemctl --user status <unit-shown-by-systemd-run>
journalctl --user-unit <unit-shown-by-systemd-run> -f
systemctl --user stop <unit-shown-by-systemd-run>
```

Stopping the unit does not roll back completed side effects. A replay of the
same authorized request asks Pipeline to reconcile its durable state.

Submit several milestones as separate authorized requests. Do not add a host
batch loop; Pipeline must own ordering and dependency decisions.

## Exact-run progress

Prefer `pipeline ship status … --json`. If typed status supplies an absolute
`events_file` for this exact ship run, the optional watcher can post selected
material events:

```bash
ship-stage-watch \
  --events-file /absolute/path/from/ship-status/events.jsonl \
  --label "ship v1.34.0" \
  --channel "<authorization channel_id>" \
  --reply-to "<authorization event_id>"
```

The watcher starts at the current event cursor, streams only that exact `events.jsonl`
through the installed `material-filter.mjs`, exits after the
completed ship event, then sends selected lines through `ship-notify.sh`.
It does not parse event shapes or inspect global loop and advance directories.
If status does not provide an exact event path, use typed status only. Do not
guess a path or select the most recently modified run.

Notification failure is observational. It must not stop, retry, or advance a
ship.

## Failure handling

- A rejected or expired authorization stops the shipment before its next
  phase. After expiry, a new signed event for the same coordinates can resume
  the frozen issue plan. An active grant cannot be replaced.
- A mechanical lifecycle failure remains owned by Pipeline's bounded recovery
  and typed terminal status.
- A missing event file affects optional progress delivery only; it does not
  change ship state.
- `ALLOW_MERGE=1` remains a host deployment opt-in. It does not replace the
  exact authorization that `pipeline ship` validates.
