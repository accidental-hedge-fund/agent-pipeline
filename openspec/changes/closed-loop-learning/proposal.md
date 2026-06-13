## Why

Recurring review findings repeat run after run because the pipeline has no mechanism to carry hard-won lessons forward. The target repo owner is best positioned to curate these patterns; the pipeline already reads the conventions file (`readConventions`) into every stage prompt, but the contract that this file is the right place to put lessons — and that the pipeline will read it without writing — has never been formally stated.

## What Changes

- **Documentation**: Add a `Human-curated lessons` section to the agent-pipeline README / SKILL.md describing the convention. A target repo MAY maintain a `#### Lessons / Gotchas` section (or dedicated file pointed at by `conventions_md_path`) that the pipeline reads as context.
- **Spec formalization**: Introduce a `human-curated-lessons-convention` spec capturing the read-only contract: the pipeline reads the lessons content via `readConventions`, all stage prompts receive it via the `{{conventions}}` placeholder, and no pipeline code path writes to or creates the conventions file.
- **Regression tests**: Confirm that `readConventions` content reaches planning and review prompt builders; confirm the stub behavior for repos without a conventions file is preserved.
- No new configuration keys, no new pipeline state, no new harness calls.

## Capabilities

### New Capabilities
- `human-curated-lessons-convention`: The contract that target repos MAY maintain a human-authored lessons section in their conventions file, and that the pipeline reads it (never writes it) into planning and review prompts via the existing `readConventions` injection.

### Modified Capabilities
<!-- No existing spec-level behavior changes. -->

## Impact

- `README.md` / `hosts/*/SKILL.md` — documentation only (new "lessons" section describing the convention).
- `core/test/` — new tests verifying `readConventions` content reaches planning/review prompt builders and confirming no write path.
- No changes to `core/scripts/`, config schema, state machine, or plugin mirror beyond regeneration if any source file changes.
