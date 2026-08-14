---
description: 'One supervisor pass for parked issue N: deterministic recover first; reflow only stale/DNR/below-high (never auto-override HIGH/CRITICAL/security); re-enter single if clear'
argument-hint: '<N>'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs recover-parked $ARGUMENTS`

See the pipeline SKILL.md for orchestration instructions when this command runs a model harness.
