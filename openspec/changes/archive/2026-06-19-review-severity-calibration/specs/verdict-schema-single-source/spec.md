## ADDED Requirements

### Requirement: The verdict schema SHALL carry an explicit non-blocking marker field

`ReviewFinding` SHALL declare an optional `blocking?: boolean` field, and
`REVIEW_VERDICT_SCHEMA_BLOCK` SHALL render it within the `findings[]` object as an unquoted
boolean hint (`true | false`). The field SHALL be optional: a verdict that omits it SHALL be
parsed and classified exactly as before this change (full backward compatibility). When present
and `false`, the field marks the finding as a non-blocking observation; the gate semantics are
specified by `review-severity-policy`. The field SHALL flow through `parseStructuredVerdict`
without a per-field allowlist change, since findings are carried through structurally.

#### Scenario: Schema block renders the non-blocking field

- **WHEN** either review prompt is rendered
- **THEN** the emitted schema block's `findings[]` object SHALL include a `blocking` field with an
  unquoted `true | false` value hint

#### Scenario: A verdict omitting the field parses unchanged

- **WHEN** a reviewer returns a verdict whose findings do not include a `blocking` field
- **THEN** `parseStructuredVerdict` SHALL parse the findings unchanged and they SHALL be
  classified exactly as before this change

#### Scenario: A verdict setting the field carries it through

- **WHEN** a reviewer returns a finding with `"blocking": false`
- **THEN** the parsed `ReviewFinding` SHALL retain `blocking === false` for the policy gate to act on

## MODIFIED Requirements

### Requirement: Drift guard test
A test SHALL assert that every field declared in `ReviewFinding` and `ReviewVerdict` is present in `REVIEW_VERDICT_SCHEMA_BLOCK`, and that every field named in `REVIEW_VERDICT_SCHEMA_BLOCK` corresponds to a field in `ReviewFinding` or `ReviewVerdict`. The test SHALL fail if either side has a field the other lacks.

In addition, the drift guard SHALL compare the value-type token of each scalar field in `ReviewFinding` and `ReviewVerdict` against the corresponding value hint in `REVIEW_VERDICT_SCHEMA_BLOCK`, using the following three-category vocabulary:
- A TypeScript `number` field SHALL map to a bare angle-bracket hint (e.g. `<int>`, `<0.0-1.0>`) — an unquoted value in the schema block.
- A TypeScript `string` field (including string-literal unions) SHALL map to a quoted hint (e.g. `"<short title>"`, `"critical" | "high" | "medium" | "low"`) — a value whose text begins with `"` in the schema block.
- A TypeScript `boolean` field SHALL map to an unquoted boolean-literal hint (`true | false`) — recognized as a distinct category from the numeric bare hint.

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

#### Scenario: Boolean field carries the boolean-literal hint — test passes
- **WHEN** `ReviewFinding.blocking` is declared `boolean` and `REVIEW_VERDICT_SCHEMA_BLOCK` renders it as the unquoted `true | false` hint
- **THEN** the drift guard test SHALL accept the boolean field's type token

#### Scenario: Boolean field given a quoted hint — test fails
- **WHEN** a `boolean` field's schema block value hint is changed to a quoted string form (e.g. `"true"`) or a numeric bare angle-bracket form
- **THEN** the drift guard test SHALL fail with a message identifying the type-token mismatch for that field

#### Scenario: New test bites before guard is added
- **WHEN** the value-type comparison assertion is removed from the test while a type mismatch exists
- **THEN** only the field-name assertions SHALL remain, and the type mismatch SHALL not be caught — proving the new assertion is the load-bearing addition

### Requirement: Schema block produces valid prompt output
The `REVIEW_VERDICT_SCHEMA_BLOCK` constant SHALL render to the same JSON structure the reviewer is expected to return (field names, nesting, and formatting), so that the reviewer's output shape is unambiguous.

#### Scenario: Rendered schema block matches the declared shape
- **WHEN** the schema constant is substituted into either review prompt
- **THEN** the resulting schema block text SHALL declare the fields in nesting order `verdict`, `summary`, `findings[{severity, title, body, file, line_start, line_end, confidence, recommendation, category, blocking}]`, `next_steps`
