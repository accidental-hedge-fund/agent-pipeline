---
description: Durable multi-item run — driven in-repo by the pipeline's own loop supervisor
argument-hint: '[--milestone <name>] [--label <label>] [--range <spec>] [--roadmap-slice <slice>] [<N> ...] [--resume <run-id>] [--audit]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs loop $ARGUMENTS`

Multi-item drive or resume is long-running (minutes to hours) and requires event following. Start or resume the loop, parse an early handoff for `run_id` and the loop events path when present (else resolve `run_id` from printed JSON / args and the loop state-home layout), follow the loop event stream with a persistent Monitor or host-equivalent, optionally follow an active item's advance events when that advance `run_id` is published, stop on a terminal loop outcome (`loop_run_stopped`) or supervisor process exit, then print a summary / `--audit`. See the pipeline SKILL.md loop orchestration section for material event kinds and the interim `events.jsonl` follow path. `--audit` alone is read-only and synchronous (no Monitor).

This command runs the durable loop entirely in-repo: a deterministic preflight (argument normalization, loop:store-schema-compatibility, native-/goal capability), then this skill's own durable loop supervisor (contract, ledger, lock, recovery, reconciliation, resume), executing each selected item through the pipeline's own state machine and evidence gates. It invokes no external orchestrator skill and never merges. The command prints the run result as JSON. On a preflight failure it stops and reports the printed remediation; do not start any substitute loop.
