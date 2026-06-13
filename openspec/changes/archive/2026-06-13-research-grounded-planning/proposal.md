## Why

Today's planning step runs a single harness call over the issue text plus a truncated conventions file. It produces a plan, but that plan is grounded only in what the conventions excerpt happens to include and whatever the model infers from the issue body. The harness already runs with `--permission-mode bypassPermissions` (full repo read access), yet nothing in the prompt instructs it to look at the actual files in scope before drafting. The result: plans that use generic advice instead of repo-specific patterns, omit acceptance criteria entirely, and leave implementation to infer correctness targets on its own.

This change strengthens the single existing planning prompt (`planning.md`) in-call: the harness is instructed to read the relevant repo files and patterns before drafting, and the plan format is extended to require an explicit, checkable acceptance-criteria section. No extra harness calls are added to the default path; no fan-out agents are introduced.

Prior-plan mining (#19-dependent) is deferred until issue #19 lands and provides accumulated findings to draw on.

## What Changes

- `core/scripts/prompts/planning.md`: add a mandatory pre-draft research instruction ("before writing the plan, read the files most relevant to this issue and identify the patterns they establish") and a required `### Acceptance criteria` section in the output format (checkable items stating the observable outcomes that make the issue done).
- `core/scripts/prompts/planning_openspec.md`: same `### Acceptance criteria` section (OpenSpec mode emits this inside the change's `proposal.md`, so the instruction mirrors the non-OpenSpec path).
- No changes to `planning.ts`, `config.ts`, `harness.ts`, or any stage handler — the behavior change is entirely within the prompt.

## Capabilities

### New Capabilities
- `planning-grounded-research`: The planning prompt SHALL instruct the harness to read and cite relevant repo files/patterns before drafting the plan, and SHALL require the plan to include an explicit, checkable `### Acceptance criteria` section.

## Scope

Small: two prompt files changed, no code touched.

## Impact

- `core/scripts/prompts/planning.md`, `core/scripts/prompts/planning_openspec.md`.
- No stage handler, type, test, or config changes.
- Mirror regeneration (`node scripts/build.mjs`) required after prompt file changes because `plugin/` mirrors the `core/scripts/prompts/` directory.
