# verdict-schema-single-source Specification

## Purpose
A single source of truth for the review verdict JSON schema: the `REVIEW_VERDICT_SCHEMA_BLOCK` constant in `core/scripts/review-schema.ts` is the only authored copy of the schema text, substituted into both review prompts (`review_standard.md`, `review_adversarial.md`) via a `{{schema_block}}` placeholder, with a field-name drift guard test that keeps the block, the `ReviewFinding`/`ReviewVerdict` types, and `parseStructuredVerdict` in agreement — so prompt↔parser drift can no longer silently drop reviewer findings (the `needs-attention/0` → blocked-run class from #45/#50/#52/#54). Value-type and nesting-level drift detection is deferred to #85.
## Requirements
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

### Requirement: Strict verdict parsing SHALL round-trip every declared finding field

`parseStrictVerdict` SHALL return findings that carry every field named in
`REVIEW_SCHEMA_FIELDS.finding` (equivalently, every member of `ReviewFinding`) whenever
that field is present in the parsed verdict JSON. This explicitly includes the
cross-round fields `prior_round_acknowledgment` (#389) and `rejected_alternatives`
(#483), which the settled-finding reversal guard and the alternative-reinstatement
guard read. No declared field SHALL be dropped by the parser's reconstruction.

Optional fields absent from the input SHALL remain absent on the parsed finding: this
requirement adds no defaulting and changes no classification for verdicts that do not
emit these fields.

#### Scenario: Delegated verdict carrying a prior-round acknowledgment retains it

- **WHEN** a delegated `stage_executors` review result returns a verdict whose finding sets `prior_round_acknowledgment` to a non-empty string
- **THEN** `parseStrictVerdict` SHALL return that finding with `prior_round_acknowledgment` equal to the emitted string

#### Scenario: Delegated verdict carrying rejected alternatives retains them

- **WHEN** a delegated `stage_executors` review result returns a verdict whose finding sets `rejected_alternatives` to a list of alternative names
- **THEN** `parseStrictVerdict` SHALL return that finding with `rejected_alternatives` equal to the emitted list, preserving order and element values

#### Scenario: Verdict omitting the cross-round fields parses unchanged

- **WHEN** a delegated review result returns a verdict whose findings omit `prior_round_acknowledgment` and `rejected_alternatives`
- **THEN** `parseStrictVerdict` SHALL parse the verdict successfully and the returned findings SHALL carry neither field, classified exactly as before this change

#### Scenario: Malformed cross-round field is a contract violation

- **WHEN** a delegated review result returns a finding whose `prior_round_acknowledgment` is not a string, or whose `rejected_alternatives` is not an array of strings
- **THEN** `parseStrictVerdict` SHALL return `null` for the whole verdict rather than coercing or discarding the field
- **AND** the run SHALL be blocked as an executor verdict contract violation, naming the stage and executor

### Requirement: The structured and strict verdict parsers SHALL share one runtime finding contract

The set of fields a parsed `ReviewFinding` carries SHALL be defined in exactly one
place in `core/scripts/stages/review-parsing.ts` and used by both
`parseStructuredVerdict` and `parseStrictVerdict`, so the local-harness path and the
delegated `stage_executors` path cannot disagree about which finding fields survive
parsing.

Sharing SHALL be limited to the field set (projection). The two parsers SHALL retain
their distinct violation policies: `parseStrictVerdict` SHALL reject a finding that
violates the type contract (returning `null` for the verdict), while
`parseStructuredVerdict` SHALL remain tolerant and SHALL NOT begin discarding or
hard-failing on findings it accepts today.

#### Scenario: Both parsers carry the same finding fields

- **WHEN** the same verdict JSON, whose finding populates every field named in `REVIEW_SCHEMA_FIELDS.finding`, is parsed by `parseStructuredVerdict` and by `parseStrictVerdict`
- **THEN** both SHALL return a finding carrying that same set of fields with the same values

#### Scenario: Tolerant path behavior is preserved

- **WHEN** a local (non-delegated) reviewer returns a finding that omits a required field such as `confidence` or `recommendation`
- **THEN** `parseStructuredVerdict` SHALL still return that finding for policy classification, exactly as before this change, and SHALL NOT drop it or fall back to a text verdict

#### Scenario: Adding a finding field requires touching only the shared contract

- **WHEN** a new field is added to `ReviewFinding` and to `REVIEW_VERDICT_SCHEMA_BLOCK`, and the shared finding projection is updated to carry it
- **THEN** both parsers SHALL round-trip the new field with no further per-parser edit

### Requirement: A parser drift guard SHALL cover finding-level fields

A test SHALL iterate `REVIEW_SCHEMA_FIELDS.finding` and assert, for each declared
field, that a verdict populating that field round-trips through both
`parseStructuredVerdict` and `parseStrictVerdict` with the field present and equal to
the emitted value. The assertion SHALL be driven by the manifest rather than a
hand-written field list, so a field newly added to `ReviewFinding` is exercised
automatically.

The guard SHALL be non-vacuous: the sample finding SHALL be type-correct for every
declared field, and the test SHALL assert the verdict parsed and returned exactly one
finding before asserting individual fields, so a parser that rejects the sample fails
the test instead of passing on an empty findings array. A newly-declared field for
which the test cannot construct a type-appropriate sample value SHALL fail the test
rather than be skipped.

#### Scenario: All declared finding fields survive — guard passes

- **WHEN** both parsers carry every field named in `REVIEW_SCHEMA_FIELDS.finding`
- **THEN** the finding-level drift guard SHALL pass

#### Scenario: A parser drops a declared finding field — guard fails

- **WHEN** a field is present in `REVIEW_SCHEMA_FIELDS.finding` but omitted from a parser's finding reconstruction
- **THEN** the drift guard SHALL fail with a message naming the dropped field and the parser that dropped it

#### Scenario: Guard cannot pass vacuously

- **WHEN** the sample verdict fails strict validation and `parseStrictVerdict` returns `null`
- **THEN** the drift guard SHALL fail on the parsed-and-exactly-one-finding assertion rather than trivially passing over zero findings

### Requirement: Cross-round guards SHALL receive parsed acknowledgments on the delegated path

A finding parsed by `parseStrictVerdict` SHALL reach the settled-finding reversal guard
and the alternative-reinstatement guard with its `prior_round_acknowledgment` and
`rejected_alternatives` values intact, so a delegated review round is governed by the
same cross-round convergence rules as a local one. The guards' own semantics SHALL be
unchanged by this requirement.

#### Scenario: Acknowledged re-raise on a delegated round is not falsely demoted

- **WHEN** a delegated review round re-raises, as blocking, a surface the prior-round digest marks settled, and the finding carries a non-empty `prior_round_acknowledgment`
- **THEN** the finding SHALL NOT be demoted to advisory with reason `reversal-unacknowledged`

#### Scenario: Unacknowledged re-raise on a delegated round is still demoted

- **WHEN** a delegated review round re-raises a settled surface as blocking with `prior_round_acknowledgment` absent, empty, or whitespace-only
- **THEN** the finding SHALL be demoted to advisory with reason `reversal-unacknowledged`, exactly as on the local path

#### Scenario: Rejected alternatives from a delegated round reach the durable digest

- **WHEN** a delegated review round emits a blocking finding with `rejected_alternatives`
- **THEN** the durable `blockingFindings` artifact entry recorded for that round SHALL carry those values as `rejectedAlternatives`, so a later round's recommendation can be checked against them

