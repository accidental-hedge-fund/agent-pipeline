# Supervisor examples

Thin adapters that implement the [supervisor contract](../../docs/supervisor.md).
They only map intent → `pipeline` CLI. They are **not** a second control plane.

| Path | Purpose |
|---|---|
| [`shell/`](./shell/) | Portable shell entrypoint (any host that can run a command) |
| [`hermes/`](./hermes/) | Hermes skill sketch (Buzz or other Hermes channels) |
| [`openclaw/`](./openclaw/) | OpenClaw skill sketch |
| [`slack/`](./slack/) | How to hang a Slack bot or slash command on the shell wrapper |

## Rules for all examples

1. Call the installed `pipeline` binary (or `node …/pipeline.mjs`).
2. Do not hardcode implementer models; use the target repo’s `.github/pipeline.yml`.
3. Do not default to `--merge` unless the deployment config sets `ALLOW_MERGE=1` (or equivalent).
4. Never put tokens, FRG keys, or private channel IDs in the repository.

## Quick start

```bash
export REPO_DIR=/path/to/checkout
export PIPELINE=pipeline   # or absolute path to pipeline.mjs
# optional: export ALLOW_MERGE=1

./examples/supervisor/shell/run-intent.sh 'train issues 1 2'
./examples/supervisor/shell/run-intent.sh 'train milestone v1.34.0'
./examples/supervisor/shell/run-intent.sh 'single 42'
```
