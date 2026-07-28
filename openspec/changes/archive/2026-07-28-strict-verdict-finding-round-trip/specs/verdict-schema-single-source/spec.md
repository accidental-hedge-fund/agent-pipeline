## ADDED Requirements

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
