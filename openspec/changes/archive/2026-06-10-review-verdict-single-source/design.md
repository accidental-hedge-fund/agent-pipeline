## Context

The review pipeline uses `parseStructuredVerdict` to extract a structured `ReviewVerdict` from reviewer output. Both review prompts (`review_standard.md`, `review_adversarial.md`) instruct the reviewer to emit JSON matching a specific schema. That schema block is currently hand-copied verbatim in both prompt files, independent of the `ReviewFinding` / `ReviewVerdict` TypeScript interfaces that the parser reads.

There is no compile-time or test-time guard: a field rename in `ReviewFinding` does not update the prompts, and vice versa. Drift causes the reviewer to emit fields the parser ignores (or miss fields the parser expects), producing silent data loss — `findings: []` → `needs-attention/0` → blocked run.

## Goals / Non-Goals

**Goals:**
- Single source of truth for the review verdict JSON schema (prompt block + TypeScript types both derive from the same artifact).
- A test that fails on field mismatch between the TypeScript types and the schema text in each prompt file.
- No observable behavior change when types and prompts are in sync.

**Non-Goals:**
- Changing any field names, types, or semantics of `ReviewFinding` / `ReviewVerdict`.
- Modifying review checklist content, operating stance, or scoring criteria in the prompts.
- Touching companion modes (`review-output.schema.json`, `codex-companion`, `claude-companion`).
- Runtime schema validation of reviewer output (that is `parseStructuredVerdict`'s domain).

## Decisions

### Decision 1: Schema constant in TypeScript, prompt block generated at call time

**Chosen**: Define a `REVIEW_VERDICT_SCHEMA_BLOCK` string constant (or a `buildSchemaBlock()` helper) in `core/scripts/types.ts` or a sibling `review-schema.ts`. The prompt template loader (`buildReviewPrompt` or equivalent) substitutes this constant into the prompt text in place of the hard-coded block, so the prompts themselves never contain a copy of the schema.

**Alternative considered**: Keep the schema in the `.md` files and write a parser that extracts the JSON block and compares it to the TypeScript types at test time. Rejected: harder to keep canonical (which file is authoritative?), and requires a fragile markdown parser in the test.

**Alternative considered**: Use a shared `.json` schema file (JSON Schema style). Rejected: over-engineering for a flat object with a fixed shape; TypeScript types are already the established convention in this repo.

### Decision 2: Drift test compares field names extracted from the TypeScript interface against the schema constant

**Chosen**: The test reads the `REVIEW_VERDICT_SCHEMA_BLOCK` constant and the `ReviewFinding` / `ReviewVerdict` interface field names (via a lightweight static list or by importing a `REVIEW_SCHEMA_FIELDS` metadata object exported alongside the types), then asserts they are equal. This avoids parsing `.md` files — the prompt files become consumers of the constant, so the test only needs to verify the constant and the types agree.

**Alternative considered**: Parse both `.md` prompt files in the test and compare their embedded JSON block to the TypeScript types. Still useful as a belt-and-suspenders check; can be added as a secondary assertion if desired.

### Decision 3: Prompt files use a `{{schema_block}}` placeholder, substituted at prompt-build time

The prompt `.md` files replace the literal JSON block with `{{schema_block}}`. The `buildReviewPrompt` (or equivalent prompt-loading) function substitutes the constant before returning the prompt string. This keeps prompt files readable without embedding the raw constant.

## Risks / Trade-offs

- **Prompt loading path must be exercised by tests** — if `buildReviewPrompt` is not called in any test, a regression where substitution is accidentally skipped would not be caught. Mitigation: the drift test should call the prompt builder and assert the output contains the expected schema fields.
- **One-time migration complexity** — existing prompt files must have their JSON block replaced with `{{schema_block}}`. Mitigation: straightforward text edit; the block is self-contained and clearly delimited.
- **Field ordering in the schema block** — the generated block must preserve the same field order as the current hand-written block to avoid spurious diff noise in prompt content. Mitigation: define field order explicitly in the constant.
