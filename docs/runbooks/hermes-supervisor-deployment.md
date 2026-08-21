# Hermes thin supervisor deployment (Phase 2b)

Replace the retired **grant factory** (`hermes-factory.service` +
`~/.local/lib/hermes-factory`) with a **thin** Hermes profile that only runs
the agent-pipeline CLI.

Contract: [supervisor.md](../supervisor.md)  
Skill template: [examples/supervisor/hermes/SKILL.md](../../examples/supervisor/hermes/SKILL.md)  
Session lessons (v1.33/v1.34 ship, Buzz thrash, PATH/pin ground truth):
[session-2026-08-ship-factory-lessons.md](./session-2026-08-ship-factory-lessons.md).

## What stays vs goes

| Keep | Disable / stop using |
|---|---|
| `hermes-gateway-pipeline-factory.service` (Buzz gateway) | `hermes-factory.service` (scoped grant runner) |
| Hermes profile `pipeline-factory` + Buzz credentials | `factory.mjs` admit/run grant path |
| `gh` + pipeline skill install | FRG attestor units for the outer wrapper |
| Control checkout for `REPO_DIR` | Grant JSON envelopes in inbox |

## 1. Install current pipeline (needs `ship`)

On the agent host, as the service user:

```bash
# From a current agent-pipeline clone (or npx install)
cd /path/to/agent-pipeline
git fetch origin main && git checkout main && git pull --ff-only
npx --yes . install --host codex --yes-deps
# or: npx -y github:accidental-hedge-fund/agent-pipeline install --host codex --yes-deps

/usr/bin/node "$HOME/.codex/skills/pipeline/scripts/pipeline.mjs" --version
# Expect a version that includes the Pipeline-owned ship coordinator.
```

Do **not** use a stale `/usr/local/bin/pipeline` if it points at an old install.

## 2. Supervisor env (mode 0600)

```bash
install -d -m 0700 "$HOME/.config/pipeline-supervisor"
install -d -m 0700 "$HOME/.local/state/pipeline-supervisor"
cp /path/to/agent-pipeline/examples/supervisor/hermes/env.example \
  "$HOME/.config/pipeline-supervisor/env"
# Edit REPO_DIR, PIPELINE, AGENT_PIPELINE_ROOT, ALLOW_MERGE
chmod 0600 "$HOME/.config/pipeline-supervisor/env"
```

Source this file from the Hermes gateway unit or a wrapper:

```bash
# drop-in or EnvironmentFile=
EnvironmentFile=%h/.config/pipeline-supervisor/env
```

Ensure `PATH` includes Node, `gh`, and the pipeline launcher directory.

## 3. Install the thin skill

```bash
PROFILE="$HOME/.hermes/profiles/pipeline-factory"
install -d -m 0700 "$PROFILE/skills/pipeline-supervisor"
cp /path/to/agent-pipeline/examples/supervisor/hermes/SKILL.md \
  "$PROFILE/skills/pipeline-supervisor/SKILL.md"
chmod 0600 "$PROFILE/skills/pipeline-supervisor/SKILL.md"

# Retire the old skill name so Hermes stops the grant path
if [ -d "$PROFILE/skills/pipeline-factory" ]; then
  mv "$PROFILE/skills/pipeline-factory" \
    "$PROFILE/skills/pipeline-factory.retired.$(date +%Y%m%d)"
fi
```

Update `SOUL.md` (optional) to say: use `/pipeline-supervisor` and the CLI only;
do not invent grants.

## 4. Disable the old factory unit

```bash
systemctl --user stop hermes-factory.service || true
systemctl --user disable hermes-factory.service || true
systemctl --user mask hermes-factory.service || true
# Optional: leave ~/.local/lib/hermes-factory as read-only archive; do not invoke it
```

Keep the gateway:

```bash
systemctl --user enable --now hermes-gateway-pipeline-factory.service
systemctl --user is-active hermes-gateway-pipeline-factory.service
```

## 5. Control checkout

`REPO_DIR` must be the **live control checkout** (e.g. `ap-main-control`).
Tugboat pins `REPO_DIR` at start and **refuses** paths matching `*factory-control*`
(#1062). Do not point ship at the retired factory-control plane.

```bash
CONTROL="${REPO_DIR:-$HOME/dev/ap-main-control}"
# Refuse known-wrong plane (matches Tugboat gate):
case "$CONTROL" in *factory-control*) echo "REFUSE factory-control REPO_DIR"; exit 1 ;; esac
git -C "$CONTROL" fetch origin
git -C "$CONTROL" checkout main
git -C "$CONTROL" pull --ff-only
```

## 6. Smoke

```bash
set -a && source "$HOME/.config/pipeline-supervisor/env" && set +a
cd "$REPO_DIR"
$PIPELINE doctor --json | head -c 500
$PIPELINE train --help 2>&1 | head -5
# Read-only intent:
ALLOW_MERGE=0 "$AGENT_PIPELINE_ROOT/examples/supervisor/shell/run-intent.sh" "status" || true
```

In Buzz (private channel): `/pipeline-supervisor status` (or your skill command)
should return doctor/status, not factory grant admit.

## 7. Merge policy

- Default `ALLOW_MERGE=0`.
- Set `ALLOW_MERGE=1` only for the private pipeline-factory channel and an
  allowlisted operator, understanding chat is not a strong security boundary
  on the same UID as `gh`.

## 8. Self-host engine promote (Phase 4)

After a release PR is merged and GitHub has published the Release for `vX.Y.Z`:

```bash
set -a && source "$HOME/.config/pipeline-supervisor/env" && set +a
cd "$REPO_DIR"
# One live pin: leave AGENT_PIPELINE_PRODUCTION_PIN unset so Tugboat binds
# $REPO_DIR/.agent-pipeline/production-engine-pin.json. Do not default
# ~/.local/state/hermes-factory/production-engine-pin.json (not pin authority).
# v1.40.1 packaging MAY template env from examples/supervisor/hermes/env.example
# and MUST NOT reintroduce a second live pin path.
# export AGENT_PIPELINE_PRODUCTION_PIN=$REPO_DIR/.agent-pipeline/production-engine-pin.json

$PIPELINE engine-promote --for X.Y.Z --host all --json
```

This verifies the published release, promotes the production engine pin (requires
FRG pass evidence for that version), runs `npx …#vX.Y.Z install`, and checks
the installed version. On install failure after pin promote, it rolls the pin
back and attempts to reinstall the previous tag.

Dry-run:

```bash
$PIPELINE engine-promote --for X.Y.Z --dry-run --json
```

## 9. Ship submission + exact-run notify

Install portable scripts from the agent-pipeline clone (no host secrets in git):

```bash
ROOT="${AGENT_PIPELINE_ROOT:-/path/to/agent-pipeline}"
install -d -m 0755 "$HOME/.local/bin"
for s in ship-milestone ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${s}.sh" "$HOME/.local/bin/$s"
done
```

Env (already partially covered in §2):

```bash
export SHIP_NOTIFY=1
export PIPELINE_MATERIAL_FILTER="$HOME/.codex/skills/pipeline/scripts/material-filter.mjs"
export PIPELINE_SHIP_AUTH_PUBLIC_KEY_FILE=/etc/agent-pipeline/ship-authority.pem
# Optional Buzz — leave unset for silent no-op notify:
# BUZZ_BIN BUZZ_RELAY_URL BUZZ_CHANNEL BUZZ_CREDENTIALS_FILE
```

```bash
# The authenticated ingress supplies this exact, immutable, expiring file.
# Hermes must not create it from free-form message text.
VALIDATED_AUTHORIZATION_FILE=/absolute/path/from/command-admission.json

# Submit one durable ship to user systemd (ALLOW_MERGE=1 required).
ship-milestone --milestone vX.Y.Z --for X.Y.Z \
  --authorization "$VALIDATED_AUTHORIZATION_FILE" --detach
ship-milestone --milestone vX.Y.Z --status

# Optional: use only an exact events_file returned by Pipeline status.
ship-stage-watch --events-file "$EXACT_EVENTS_FILE" --label "ship vX.Y.Z" \
  --channel "$AUTH_CHANNEL_ID" --reply-to "$AUTH_EVENT_ID"
```

See [ship-milestone.md](./ship-milestone.md) and
[frg-pack-checklist.md](./frg-pack-checklist.md).  
Refresh the Hermes skill from `examples/supervisor/hermes/SKILL.md` after pull
so “ship milestone …” phrases map to the thin adapter.

The adapter uses `systemd-run --user --collect`. Use `systemctl --user` and
`journalctl --user-unit` for process status, logs, and stop. Pipeline owns
lifecycle state and resume; do not add PID files, host locks, or release polling.

## Rollback

```bash
systemctl --user unmask hermes-factory.service
# Restore retired skill directory if needed
# Do not re-enable grant factory for new work without an explicit product decision
```
