## 1. Add type-annotation parser

- [x] 1.1 Add `parseInterfaceFieldTypes(src: string, interfaceName: string): Record<string, string>` to `core/test/review-schema.test.ts` — extends the line regex to capture the annotation token (everything after `?:` up to `;` / `//` / end-of-line), trimmed; skips lines with no scalar token (arrays, nested types). Does not touch the existing `parseInterfaceFields`.
- [x] 1.2 Add a regression case to the existing `parseInterfaceFields regression` test (or a new parallel test for `parseInterfaceFieldTypes`) covering `number`, `string`, quoted string-literal union, and optional numeric forms.

## 2. Add schema-block value-hint parser

- [x] 2.1 Add `parseSchemaBlockValueHints(block: string): Record<string, 'number' | 'string' | 'other'>` to `core/test/review-schema.test.ts` — walks `REVIEW_VERDICT_SCHEMA_BLOCK` with the existing depth-tracking pattern; captures the value text per key; classifies as `number` (bare `<…>`) or `string` (starts with `"`); returns `other` for non-scalar values (arrays, nested objects) which are skipped by the assertion.

## 3. Add type-token drift guard test

- [x] 3.1 Add test `"drift guard: value-type tokens match schema block value hints"` that:
  1. Calls `parseInterfaceFieldTypes` for `ReviewFinding` and `ReviewVerdict` (excluding `commitSha`).
  2. Calls `parseSchemaBlockValueHints` on `REVIEW_VERDICT_SCHEMA_BLOCK`.
  3. For each scalar field, asserts the TS category (`number` or `string`) equals the schema hint category; reports field name and both categories on failure.
- [x] 3.2 Prove the test bites: temporarily change `line_start?: number` to `line_start?: string` in `types.ts` (or annotate the proof in the PR description), confirm the new test fails, then revert — restoring green CI.

## 4. Mirror + CI

- [x] 4.1 Regenerate the plugin mirror: `node scripts/build.mjs` (test-only change; mirror content should be unchanged, but the check must still pass).
- [x] 4.2 Run `npm run ci` from repo root — all tests green before marking done.
