---
description: Durable multi-item run — delegates to the installed goal-loop skill
argument-hint: '[--milestone <name>] [--label <label>] [--range <spec>] [--roadmap-slice <slice>] [<N> ...] [--resume <run-id>] [--audit]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs loop $ARGUMENTS`

Run synchronously (completes in seconds). No background process or Monitor needed.

This command only runs the deterministic loop preflight (argument normalization, loop:contract-coherence, native-/goal capability) and prints the compiled selector as JSON. On success, delegate to the installed goal-loop skill's own instructions (its SKILL.md) using that selector — durable run identity, the ledger, locking, and resume all live in goal-loop, not here. On failure, stop and report the printed remediation; do not start any substitute loop.
