---
description: Dry-run ordered merge plan for ready-to-deploy PRs in a milestone (never called by advance; human owns merge)
argument-hint: '--milestone "<title>" [--dry-run]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs merge-queue $ARGUMENTS`

Run synchronously (completes in seconds). No background process or Monitor needed.
