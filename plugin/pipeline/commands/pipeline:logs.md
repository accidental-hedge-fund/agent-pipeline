---
description: 'List or stream pipeline run logs (events --follow exits 0 on run_complete; --no-until-terminal for interrupt-only)'
argument-hint: '[<run-id>] [--events] [-f]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs logs $ARGUMENTS`

Run synchronously (completes in seconds). No background process or Monitor needed.
