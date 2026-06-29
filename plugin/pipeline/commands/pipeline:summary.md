---
description: Print the evidence bundle for issue N
argument-hint: <N>
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs $1 --summary`

Run synchronously (completes in seconds). No background process or Monitor needed.

Note: pass the issue number as the sole argument. `$1` is expanded to that number by this command.
