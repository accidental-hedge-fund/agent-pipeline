## ADDED Requirements

### Requirement: Single source of truth for the review verdict JSON schema
The review verdict JSON schema (fields, types, and nesting) SHALL be defined once as a TypeScript constant or structured metadata object (`REVIEW_VERDICT_SCHEMA_BLOCK` or equivalent) exported from `core/scripts/types.ts` or a co-located `review-schema.ts`. No other file in the codebase SHALL contain a hand-copied duplicate of this schema block.

Single-sourcing here means exactly one authored copy of the schema **text** (which expresses the field names, their type hints, and nesting). Enforcing agreement of field value *types* between that text and the `ReviewFinding`/`ReviewVerdict` interfaces at test time is **out of scope** for this change (see the *Drift guard test* requirement below and #85); the drift guard added here is field-name-scoped.

#### Scenario: Schema constant is the only copy
- **WHEN** `review_standard.md` or `review_adversarial.md` is rendered
- **THEN** the emitted JSON schema block SHALL be derived from the shared constant, not from literal text embedded in the `.md` file

#### Scenario: Adding a field to ReviewFinding propagates to prompts
- **WHEN** a new field is added to the `ReviewFinding` TypeScript interface and the schema constant is updated to match
- **THEN** both review prompts SHALL include the new field in their schema block without any manual edit to the `.md` files

### Requirement: Prompt template substitution for schema block
Both `review_standard.md` and `review_adversarial.md` SHALL use a `{{schema_block}}` placeholder at the location where the JSON schema block appears. The prompt-building function SHALL substitute the `REVIEW_VERDICT_SCHEMA_BLOCK` constant for `{{schema_block}}` before the prompt is sent to the reviewer.

#### Scenario: Placeholder is resolved before use
- **WHEN** either review prompt is loaded for a review round
- **THEN** the returned prompt string SHALL contain no literal `{{schema_block}}` placeholder and SHALL contain the current schema block text

#### Scenario: Unresolved placeholder is a hard error
- **WHEN** the prompt template is loaded and substitution is skipped or fails
- **THEN** the system SHALL throw rather than send a prompt with a literal `{{schema_block}}` token to the reviewer

### Requirement: Drift guard test
A test SHALL assert that every field declared in `ReviewFinding` and `ReviewVerdict` is present in `REVIEW_VERDICT_SCHEMA_BLOCK`, and that every field named in `REVIEW_VERDICT_SCHEMA_BLOCK` corresponds to a field in `ReviewFinding` or `ReviewVerdict`. The test SHALL fail if either side has a field the other lacks.

This requirement covers **field-name** drift only (a field added, renamed, or removed). Detecting drift in a field's value **type** (e.g. `number` → `string`) or in the schema's **nesting/shape** while the field name is unchanged is **out of scope** for this change and is tracked separately in #85. A name-level guard satisfies this requirement.

#### Scenario: Types and schema block agree — test passes
- **WHEN** `ReviewFinding` and `ReviewVerdict` fields exactly match the fields enumerated in `REVIEW_VERDICT_SCHEMA_BLOCK`
- **THEN** the drift guard test SHALL pass

#### Scenario: Field added to ReviewFinding but not schema block — test fails
- **WHEN** a new field is added to `ReviewFinding` without updating `REVIEW_VERDICT_SCHEMA_BLOCK`
- **THEN** the drift guard test SHALL fail with a message identifying the missing field

#### Scenario: Field added to schema block but not ReviewFinding — test fails
- **WHEN** a new field is added to `REVIEW_VERDICT_SCHEMA_BLOCK` without adding it to `ReviewFinding`
- **THEN** the drift guard test SHALL fail with a message identifying the extra field

### Requirement: Schema block produces valid prompt output
The `REVIEW_VERDICT_SCHEMA_BLOCK` constant SHALL render to the same JSON structure that the current hand-copied blocks contain (field names, nesting, and formatting), so that the reviewer's output shape is unchanged.

#### Scenario: Rendered schema block matches historical shape
- **WHEN** the schema constant is substituted into either review prompt
- **THEN** the resulting schema block text SHALL declare the same fields in the same nesting order as the previous hand-written block (`verdict`, `summary`, `findings[{severity, title, body, file, line_start, line_end, confidence, recommendation}]`, `next_steps`)
