---
description: 'Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete'
argument-hint: '--milestone <title> [--apply] [--release-when-complete --release-version <v>]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs merge-queue $ARGUMENTS`

See the pipeline SKILL.md for orchestration instructions when this command runs a model harness.
