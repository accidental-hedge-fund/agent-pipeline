# Hermes thin supervisor deployment (Phase 2b)

Replace the retired **grant factory** (`hermes-factory.service` +
`~/.local/lib/hermes-factory`) with a **thin** Hermes profile that only runs
the agent-pipeline CLI.

Contract: [supervisor.md](../supervisor.md)  
Skill template: [examples/supervisor/hermes/SKILL.md](../../examples/supervisor/hermes/SKILL.md)

## What stays vs goes

| Keep | Disable / stop using |
|---|---|
| `hermes-gateway-pipeline-factory.service` (Buzz gateway) | `hermes-factory.service` (scoped grant runner) |
| Hermes profile `pipeline-factory` + Buzz credentials | `factory.mjs` admit/run grant path |
| `gh` + pipeline skill install | FRG attestor units for the outer wrapper |
| Control checkout for `REPO_DIR` | Grant JSON envelopes in inbox |

## 1. Install current pipeline (needs `train` + `release finish`)

On the agent host, as the service user:

```bash
# From a current agent-pipeline clone (or npx install)
cd /path/to/agent-pipeline
git fetch origin main && git checkout main && git pull --ff-only
npx --yes . install --host codex --yes-deps
# or: npx -y github:accidental-hedge-fund/agent-pipeline install --host codex --yes-deps

/usr/bin/node "$HOME/.codex/skills/pipeline/scripts/pipeline.mjs" --version
# Expect a version that includes train (post-#922) and release finish (this change)
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

```bash
CONTROL="${REPO_DIR:-$HOME/dev/agent-pipeline-factory-control}"
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

## Rollback

```bash
systemctl --user unmask hermes-factory.service
# Restore retired skill directory if needed
# Do not re-enable grant factory for new work without an explicit product decision
```
