## MODIFIED Requirements

### Requirement: Drift guard test
A test SHALL assert that every field declared in `ReviewFinding` and `ReviewVerdict` is present in `REVIEW_VERDICT_SCHEMA_BLOCK`, and that every field named in `REVIEW_VERDICT_SCHEMA_BLOCK` corresponds to a field in `ReviewFinding` or `ReviewVerdict`. The test SHALL fail if either side has a field the other lacks.

In addition, the drift guard SHALL compare the value-type token of each scalar field in `ReviewFinding` and `ReviewVerdict` against the corresponding value hint in `REVIEW_VERDICT_SCHEMA_BLOCK`, using the following two-category vocabulary:
- A TypeScript `number` field SHALL map to a bare angle-bracket hint (e.g. `<int>`, `<0.0-1.0>`) — an unquoted value in the schema block.
- A TypeScript `string` field (including string-literal unions) SHALL map to a quoted hint (e.g. `"<short title>"`, `"critical" | "high" | "medium" | "low"`) — a value whose text begins with `"` in the schema block.

Non-scalar fields (arrays, nested objects) are excluded from the type-token comparison.

#### Scenario: Types and schema block agree — test passes
- **WHEN** `ReviewFinding` and `ReviewVerdict` fields exactly match the fields enumerated in `REVIEW_VERDICT_SCHEMA_BLOCK`, and every scalar field's TS type token matches the schema block's value-hint category
- **THEN** the drift guard test SHALL pass

#### Scenario: Field added to ReviewFinding but not schema block — test fails
- **WHEN** a new field is added to `ReviewFinding` without updating `REVIEW_VERDICT_SCHEMA_BLOCK`
- **THEN** the drift guard test SHALL fail with a message identifying the missing field

#### Scenario: Field added to schema block but not ReviewFinding — test fails
- **WHEN** a new field is added to `REVIEW_VERDICT_SCHEMA_BLOCK` without adding it to `ReviewFinding`
- **THEN** the drift guard test SHALL fail with a message identifying the extra field

#### Scenario: Numeric field in types changed to string — test fails
- **WHEN** a field declared as `number` in `ReviewFinding` (e.g. `line_start`) is changed to `string` while `REVIEW_VERDICT_SCHEMA_BLOCK` still carries the corresponding bare angle-bracket hint (e.g. `<int>`)
- **THEN** the drift guard test SHALL fail with a message identifying the type-token mismatch for that field

#### Scenario: String field in schema block changed to bare hint — test fails
- **WHEN** a field whose TS type is `string` has its schema block value hint changed from a quoted form to a bare angle-bracket form (or vice versa)
- **THEN** the drift guard test SHALL fail with a message identifying the type-token mismatch for that field

#### Scenario: New test bites before guard is added
- **WHEN** the value-type comparison assertion is removed from the test while a type mismatch exists
- **THEN** only the field-name assertions SHALL remain, and the type mismatch SHALL not be caught — proving the new assertion is the load-bearing addition
