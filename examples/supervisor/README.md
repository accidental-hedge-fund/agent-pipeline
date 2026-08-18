# Supervisor examples

Thin adapters that implement the [supervisor contract](../../docs/supervisor.md).
They only map intent → `pipeline` CLI. They are **not** a second control plane.

| Path | Purpose |
|---|---|
| [`shell/`](./shell/) | Portable shell entrypoints (intent, ship composer, notify, exact-run watch) |
| [`hermes/`](./hermes/) | Hermes skill sketch (Buzz or other Hermes channels) |
| [`openclaw/`](./openclaw/) | OpenClaw skill sketch |
| [`slack/`](./slack/) | How to hang a Slack bot or slash command on the shell wrapper |

## Shell scripts

| Script | Purpose |
|---|---|
| **`tugboat.sh`** | Thin notify/detach adapter. Product ship is `pipeline ship --milestone`. Tugboat must not own merge order, classification, or a second ledger. |
| `ship-notify.sh` | Optional Buzz status posts; **no-op** without messenger env (shared with Tugboat). Retries transient send failures; audits under `$PIPELINE_SUPERVISOR_STATE/notify/` (`audit.log`, `failed/*`); still exit 0 so ship never blocks on delivery. |
| `ship-stage-watch.sh` | Stream one explicit run event file through `material-filter.mjs` (shared) |
| `train-status-complete.py` | Pure helper: last `train_status` complete gate from mixed prose+JSON (`raw_decode`) |
| `release-checks-green.py` | Shared ship-release check waiter: classify `gh pr checks --json` as green/pending/rerun/fail (`bucket`+`link`; bounded flake-eligible rerun) |
| `run-intent.sh` | Map a short intent string → `pipeline train` / `single` |
| `pipeline-launcher.sh` | Resolve installed `pipeline` without hardcoding host paths. On the factory control plane, exports `AGENT_PIPELINE_PRODUCTION_PIN` when unset. |
| `frg-pack-helpers.sh` | Secret-free `factory-release prepare` request writer + pack-tick classifier. Sourced by the playbook. Tugboat inlines the same helpers. |
| `pipeline-ship-playbook.sh` | Leftover thin chain adapter (not the product owner) |
| `ship-milestone.sh` | Parked grant-style adapter; not the operator surface |

Ship runbook: [docs/runbooks/ship-milestone.md](../../docs/runbooks/ship-milestone.md)  
FRG checklist: [docs/runbooks/frg-pack-checklist.md](../../docs/runbooks/frg-pack-checklist.md)

## Rules for all examples

1. Call the installed `pipeline` binary (or `node …/pipeline.mjs`).
2. Do not hardcode implementer models; use the target repo’s `.github/pipeline.yml`.
3. Do not default to `--merge` unless the deployment config sets `ALLOW_MERGE=1` (or equivalent).
4. Never put tokens, FRG keys, private channel IDs, or host home paths in the repository.
5. Observe only an exact event path returned by Pipeline. Never discover a host-global “latest run.”

## Quick start — in-engine ship

```bash
export REPO_DIR=/path/to/checkout
export PIPELINE=pipeline   # or absolute path to pipeline.mjs
export ALLOW_MERGE=1       # required for train --merge / release finish

# Install once (keep ~/.local/bin in sync with examples/supervisor/shell/):
ROOT=/path/to/agent-pipeline
install -d -m 0755 "$HOME/.local/bin"
for f in tugboat ship-notify ship-stage-watch pipeline-launcher; do
  install -m 0755 "$ROOT/examples/supervisor/shell/${f}.sh" "$HOME/.local/bin/$f"
done
install -m 0755 "$ROOT/examples/supervisor/shell/train-status-complete.py" \
  "$HOME/.local/bin/train-status-complete.py"
install -m 0755 "$ROOT/examples/supervisor/shell/release-checks-green.py" \
  "$HOME/.local/bin/release-checks-green.py"

# Phrase: Ship milestone vX.Y.Z
pipeline ship --milestone v1.37.0 --json

# Status (no side effect — reads the Pipeline ship ledger)
pipeline ship status --milestone v1.37.0 --json
```

Required env for a mutating ship: `REPO_DIR`, `PIPELINE`, `ALLOW_MERGE=1`.  
Optional: `ENGINE_PROMOTE_HOST` (default `all`), `SHIP_NOTIFY`, wait budgets.

If Buzz is quiet during a ship, check
`$PIPELINE_SUPERVISOR_STATE/notify/audit.log` and `notify/failed/` (default state
root `~/.local/state/pipeline-supervisor`). Reinstall `ship-notify` from
`examples/supervisor/shell/` with the same sibling install loop after `main`
moves — host copies are not auto-updated.

**Not in this product:** grant factory, MessagingPort / ship-auth issuer, shared NL platform. #1001 / #971 do not ban in-engine `pipeline ship`.

## Other intents

```bash
export REPO_DIR=/path/to/checkout
export PIPELINE=pipeline

./examples/supervisor/shell/run-intent.sh 'train issues 1 2'
./examples/supervisor/shell/run-intent.sh 'train milestone v1.34.0'
./examples/supervisor/shell/run-intent.sh 'single 42'
```
