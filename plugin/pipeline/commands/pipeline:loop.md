---
description: Durable multi-item run — driven in-repo by the pipeline's own loop supervisor
argument-hint: '[--milestone <name>] [--label <label>] [--range <spec>] [--roadmap-slice <slice>] [<N> ...] [--resume <run-id>] [--audit]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs loop $ARGUMENTS`

Runs in the foreground for the wall-clock duration of the multi-item drive. On successful create/resume and exclusive lock, emits an early machine-readable stdout JSON line (`kind: "loop_run_handoff"`) with `run_id` and absolute `events` path so a harness can follow structured progress; the terminal summary JSON is printed when the supervisor finishes. `--audit` remains short-lived and read-only.

This command runs the durable loop entirely in-repo: a deterministic preflight (argument normalization, loop:store-schema-compatibility, native-/goal capability), then this skill's own durable loop supervisor (contract, ledger, lock, recovery, reconciliation, resume), executing each selected item through the pipeline's own state machine and evidence gates. It invokes no external orchestrator skill and never merges. After lock acquisition it prints an early `loop_run_handoff` JSON object (`run_id` + absolute `events` path) for progress follow, then the terminal run result as JSON when the supervisor returns. On a preflight failure it stops and reports the printed remediation; do not start any substitute loop.
