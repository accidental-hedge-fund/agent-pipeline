---
name: pipeline-supervisor
description: >
  Thin Hermes skill: map operator messages to the agent-pipeline CLI.
  Use only after the operator has installed pipeline and authenticated gh.
  Does not implement a second state machine or grant factory.
---

# Pipeline supervisor (Hermes example)

Read [docs/supervisor.md](../../../docs/supervisor.md) first.

## Rules

1. Call the installed `pipeline` CLI only. Do not invent stages, models, or effort.
2. Prefer the shell wrapper for intent parsing when available:

```bash
export REPO_DIR=/path/to/target/repo
export PIPELINE=/path/to/pipeline   # or `pipeline` on PATH
# export ALLOW_MERGE=1   # only if this deployment may merge

/path/to/agent-pipeline/examples/supervisor/shell/run-intent.sh '<intent>'
```

3. Never default to `--merge` / `ALLOW_MERGE=1` from a vague “run the milestone.”
4. Post short status summaries. Never paste secrets, env dumps, or full harness logs.
5. On `needs-human` or non-zero exit, report the error and stop. Do not force-merge.

## Suggested intents

| Operator message | Wrapper intent |
|---|---|
| `single 42` / `do #42` | `single 42` |
| `train issues 10 11 12` | `train issues 10,11,12` |
| `train milestone v1.34.0` | `train milestone v1.34.0` |
| `… and merge` (explicit) | same + requires `ALLOW_MERGE=1` |

## Long runs

Start train with a non-blocking host job if your chat tool times out (e.g.
`systemctl --user start --no-block …` or background process). The **factory
controller is the pipeline process**, not the chat turn. Heartbeat by reading
the process exit status and last `--json` output, or by `pipeline status <N>`.

## What this skill is not

- Not the removed `ops/hermes-factory` grant runner  
- Not a durable ledger  
- Not authorization for merge — `gh` credentials on the host are  
