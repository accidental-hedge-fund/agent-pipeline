# Slack (example notes)

Agent-pipeline does **not** ship a Slack app. To use Slack as a remote control:

## Pattern

1. Slack slash command or bot message → your small service (Bolt, Workflow, etc.).
2. Service checks **channel + user allowlist** (host config / secrets).
3. Service runs:

```bash
export REPO_DIR=/path/to/checkout
export PIPELINE=pipeline
# export ALLOW_MERGE=1   # only for a private, trusted channel if you must

/path/to/agent-pipeline/examples/supervisor/shell/run-intent.sh "$TEXT"
```

4. Reply with a short summary: exit code, `complete` / `blocker` from train JSON.

## Recommendations

| Topic | Guidance |
|---|---|
| Merge | Do not enable `ALLOW_MERGE` on public channels |
| Timeouts | Slack 3s slash ACK → run train async; post follow-up message |
| Secrets | Bot token and `gh` token stay on the runner host |
| UX | Prefer explicit forms: `/pipeline train milestone v1.34.0` |

## Non-goals

- No OAuth install flow in this repo  
- No second Slack-specific state machine  
- Same [supervisor contract](../../../docs/supervisor.md) as Hermes and OpenClaw  
