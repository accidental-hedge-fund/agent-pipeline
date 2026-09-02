---
name: pipeline-supervisor
description: >
  Thin OpenClaw skill sketch: compose agent-pipeline via CLI.
  Platform I/O only; pipeline owns trains and stages.
---

# Pipeline supervisor (OpenClaw example)

Same contract as Hermes: [docs/supervisor.md](../../../docs/supervisor.md).

## Invoke

OpenClaw (or any agent host) should run a **bounded shell tool** against the
shell wrapper rather than re-implementing train logic in prompts:

```bash
export REPO_DIR="${PIPELINE_REPO_DIR:?set me}"
export PIPELINE="${PIPELINE_BIN:-pipeline}"
# export ALLOW_MERGE=1

"$AGENT_PIPELINE_ROOT/examples/supervisor/shell/run-intent.sh" "$OPERATOR_TEXT"
```

Map operator natural language to the short intent strings in the wrapper
(`single N`, `train issues …`, `train milestone …`). Phrase
`Ship milestone vX.Y.Z` execs `pipeline ship --milestone vX.Y.Z` (detach if
blocking). Status: `pipeline ship status --milestone vX.Y.Z`. Prefer
deterministic regex extraction of issue numbers and milestone titles over
free-form CLI invention.

## Isolation tips

- Run the CLI on a machine that already has `gh` auth and the repo checkout.
- Keep OpenClaw’s tools least-privilege: allow the wrapper script, not arbitrary `git push --force`.
- Disable merge-capable intents unless the workspace is private and allowlisted.

## Liveness (reattach, not retry)

A dead worker or interrupted follow is non-terminal. It is not human authority.

```bash
"$PIPELINE" liveness status --json
"$PIPELINE" liveness restore --json
"$PIPELINE" logs <run-id> --events --follow
"$PIPELINE" loop logs <loop-run-id> --events --follow
```

Do not classify a dead worker. Do not retry `pipeline single` because follow stopped. Do not merge from follow.

## Status

On completion, surface the JSON printed by `pipeline train --json`
(`kind: "train_status"`, `schema_version: 1`). Mid-flight, use
`pipeline status <N>` or loop event follow if the host supports long monitors.
