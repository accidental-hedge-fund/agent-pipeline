## Context

`parseInterfaceFields` (line 29, `review-schema.test.ts`) matches `/^\s*(?:readonly\s+)?(?:(\w+)|"(\w+)")\??:/` and keeps only the captured identifier — the `: number` or `: string` annotation is sliced off before the token is pushed. As a result, the three `ReviewFinding` numeric fields (`line_start`, `line_end`, `confidence`) could be changed to `string` in `types.ts` while the schema block's `<int>` / `<0.0-1.0>` hints survive the guard unchanged.

The schema block value hints fall into two structural categories:
- **Bare angle-bracket hints** (`<int>`, `<0.0-1.0>`) — unquoted, represent numeric fields.
- **Quoted string hints** (`"<short title>"`, `"critical" | "high" | "medium" | "low"`, `"approve" or "needs-attention"`) — wrapped in double-quotes, represent string or string-union fields.

## Goals / Non-Goals

**Goals:**
- Add a test that fails when a TS `number` field has a quoted-string hint (or vice versa) in `REVIEW_VERDICT_SCHEMA_BLOCK`.
- Add the parsers (`parseInterfaceFieldTypes`, `parseSchemaBlockValueHints`) as pure functions in the test file, with no changes to production code.
- Prove the new test bites: it must fail before the type-token comparison is added.

**Non-Goals:**
- Full AST parsing or exhaustive union type-checking.
- Nesting / shape comparison (explicitly out of scope per the issue).
- Any change to the schema block text, types, prompts, or runtime verdict parsing.
- Guarding the `findings` array type or `next_steps` array type (complex types, not scalar tokens).

## Decisions

### 1. Sibling parser, not extension of `parseInterfaceFields`

Add a separate `parseInterfaceFieldTypes(src, interfaceName): Record<string, string>` rather than changing `parseInterfaceFields`. The existing function's return type (`string[]`) and all callers stay unchanged; the new function returns a name→token map alongside it. Changing `parseInterfaceFields` would require updating all four callers and the regression test that asserts its exact output.

### 2. Two-category vocabulary: `number` vs `string`

Map TS type annotations to two schema-hint categories:
- TS token starts with `number` → expect a **bare** angle-bracket hint (not quoted) in the schema block.
- TS token starts with `string` or is a quoted string literal union → expect a **quoted** hint (the value text starts with `"`).

Fields typed as arrays, nested objects, or optional-only wrappers are skipped (no scalar token to compare). This keeps the check simple and avoids false positives on `findings: ReviewFinding[]` or `next_steps: string[]`.

The TS-token extraction regex extension: change `\??:` to `\??:\s*([^;/\n]+)` and trim the captured group, yielding the raw annotation (`number`, `string`, `"critical" | "high" | "medium" | "low"`, etc.).

### 3. Schema block value-hint parsing

`parseSchemaBlockValueHints` walks `REVIEW_VERDICT_SCHEMA_BLOCK` key-by-key (same depth tracking already in `parseSchemaBlockFields`) and captures the value text (the substring after `:` up to `,` or `\n`), classifying it as `number` (bare `<…>` or an unquoted numeric token) or `string` (starts with `"`). Fields at non-scalar depth (the `findings` array, `next_steps` array) return category `other` and are excluded from the assertion.

### 4. Test-bites proof

The PR must include a commit (or test-file annotation) demonstrating the new test fails when `line_start?: number` is temporarily changed to `line_start?: string` or when the schema block `<int>` hint is changed to `"<int>"`. This is the canonical "prove the test bites" step required by the project conventions.

## Risks / Trade-offs

- **Regex fragility** → the value extraction regex is intentionally narrow (single-line, stops at `,` / `\n`) and tested via the regression test pattern already in the file; adding more `SyntheticA`-style inline test cases covers new parse forms before they reach production.
- **Vocabulary is a two-bucket approximation** → a future third scalar type (e.g. `boolean`) would need a new bucket and a schema hint convention. Document the mapping in a comment alongside the parsers.

## Open Questions

_(none — scope is locked by the issue's maintainer rescope decision)_
