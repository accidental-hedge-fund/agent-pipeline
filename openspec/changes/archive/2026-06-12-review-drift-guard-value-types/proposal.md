## Why

The existing field-name drift guard (`review-schema.test.ts`) ignores value types: `parseInterfaceFields` keeps only the identifier and discards the `: number` annotation, so flipping `line_start?: number` → `line_start?: string` in `types.ts` passes the guard while the schema block still advertises `<int>` — the contract we hand the reviewer silently lies. This change adds a lightweight type-token comparison so documentation integrity is enforced end-to-end.

## What Changes

- `core/test/review-schema.test.ts`: add a sibling parser `parseInterfaceFieldTypes` that captures the type annotation token per field alongside the existing name extraction; add `parseSchemaBlockValueHints` to read per-field value-hint categories (`number` | `string`) from `REVIEW_VERDICT_SCHEMA_BLOCK`; add one new test that fails when a TS type token diverges from its schema block hint.
- No changes to `review-schema.ts`, `types.ts`, the emitted verdict shape, review prompts, or any stage logic.

## Capabilities

### New Capabilities

_(none — this change extends an existing guard, not a new runtime capability)_

### Modified Capabilities

- `verdict-schema-single-source`: the Drift guard test requirement gains a normative value-type token comparison — the guard now covers field-name **and** value-type drift.

## Impact

`core/test/review-schema.test.ts` only. No application code, no schema block text, no runtime behavior changes.
