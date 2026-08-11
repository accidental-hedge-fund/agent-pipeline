---
description: Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes)
argument-hint: '--epic <N> [--description "…"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl]'
---

Invoke: `node ${CLAUDE_PLUGIN_ROOT}/skills/pipeline/scripts/pipeline.mjs decompose $ARGUMENTS`

See the pipeline SKILL.md for orchestration instructions when this command runs a model harness.
