---
description: Durable multi-item run — driven in-repo by the pipeline's own loop supervisor
argument-hint: '[--milestone <name>] [--label <label>] [--range <spec>] [--roadmap-slice <slice>] [<N> ...] [--resume <run-id>] [--audit]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs loop $ARGUMENTS`

Run synchronously (completes in seconds). No background process or Monitor needed.

This command runs the durable loop entirely in-repo: a deterministic preflight (argument normalization, loop:store-schema-compatibility, native-/goal capability), then this skill's own durable loop supervisor (contract, ledger, lock, recovery, reconciliation, resume), executing each selected item through the pipeline's own state machine and evidence gates. It invokes no external orchestrator skill and never merges. The command prints the run result as JSON. On a preflight failure it stops and reports the printed remediation; do not start any substitute loop.
