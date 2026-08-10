# Supervisor examples

Thin adapters that implement the [supervisor contract](../../docs/supervisor.md).
They only map intent → `pipeline` CLI. They are **not** a second control plane.

| Path | Purpose |
|---|---|
| [`shell/`](./shell/) | Portable shell entrypoints (intent, ship adapter, notify, exact-run watch) |
| [`hermes/`](./hermes/) | Hermes skill sketch (Buzz or other Hermes channels) |
| [`openclaw/`](./openclaw/) | OpenClaw skill sketch |
| [`slack/`](./slack/) | How to hang a Slack bot or slash command on the shell wrapper |

## Shell scripts

| Script | Purpose |
|---|---|
| `run-intent.sh` | Map a short intent string → `pipeline train` / `single` |
| `ship-milestone.sh` | Forward one authorized request/status call to `pipeline ship`; optional systemd detach |
| `pipeline-ship-playbook.sh` | **Chain-to-existing-tools ship** for builds without the `ship` subcommand: trains the milestone, releases, finishes, waits, and engine-promotes by composing existing `pipeline` commands (auto-generates the FRG release gate via `pipeline-ship-frg` when missing) |
| `ship-notify.sh` | Optional Buzz status posts; **no-op** without messenger env |
| `ship-stage-watch.sh` | Stream one explicit run event file through `material-filter.mjs` |
| `pipeline-launcher.sh` | Resolve installed `pipeline` without hardcoding host paths |

Ship runbook: [docs/runbooks/ship-milestone.md](../../docs/runbooks/ship-milestone.md)  
FRG checklist: [docs/runbooks/frg-pack-checklist.md](../../docs/runbooks/frg-pack-checklist.md)

## Rules for all examples

1. Call the installed `pipeline` binary (or `node …/pipeline.mjs`).
2. Do not hardcode implementer models; use the target repo’s `.github/pipeline.yml`.
3. Do not default to `--merge` unless the deployment config sets `ALLOW_MERGE=1` (or equivalent).
4. Never put tokens, FRG keys, private channel IDs, or host home paths in the repository.
5. Observe only an exact event path returned by Pipeline. Never discover a host-global “latest run.”

## Quick start

```bash
export REPO_DIR=/path/to/checkout
export PIPELINE=pipeline   # or absolute path to pipeline.mjs
# optional: export ALLOW_MERGE=1

./examples/supervisor/shell/run-intent.sh 'train issues 1 2'
./examples/supervisor/shell/run-intent.sh 'train milestone v1.34.0'
./examples/supervisor/shell/run-intent.sh 'single 42'

# Full ship (requires ALLOW_MERGE=1 and an exact validated authorization):
export ALLOW_MERGE=1
./examples/supervisor/shell/ship-milestone.sh \
  --milestone v1.34.0 \
  --authorization /absolute/path/to/authorization.json \
  --detach
./examples/supervisor/shell/ship-milestone.sh \
  --milestone v1.34.0 --status
```
