## ADDED Requirements

### Requirement: Review-mode prompts SHALL carry the production structured verdict contract

The runner SHALL state the production structured verdict contract in the prompt it
materializes for the `review` stage — in stage mode and as part of an `end-to-end`
sequence — namely the review verdict JSON schema and an instruction to return only that
JSON object and nothing else. The schema
text SHALL be substituted from the single-sourced `REVIEW_VERDICT_SCHEMA_BLOCK` constant
rather than duplicated in the evaluation runner, so a change to the production contract
reaches review-mode evaluation automatically.

The materialized prompt SHALL contain no unsubstituted placeholder token. Prompts for the
`planning`, `plan-review`, `implementing`, `fix`, and `shipcheck` stages SHALL be
unchanged by this requirement.

#### Scenario: A review-mode prompt states the verdict contract

- **WHEN** the runner materializes the prompt for a `review`-stage cell from a fixture's frozen stage-entry artifact
- **THEN** the prompt SHALL contain the exact text of `REVIEW_VERDICT_SCHEMA_BLOCK`
- **AND** SHALL instruct the reviewer to return only that JSON object and no other prose

#### Scenario: The contract text tracks the production constant

- **WHEN** `REVIEW_VERDICT_SCHEMA_BLOCK` changes
- **THEN** the review-mode evaluation prompt SHALL carry the changed text without a separate edit to the evaluation runner
- **AND** a test SHALL fail if the review-mode prompt's schema text diverges from the constant

#### Scenario: Non-review stage prompts are unchanged

- **WHEN** the runner materializes the prompt for a `planning`, `plan-review`, `implementing`, `fix`, or `shipcheck` cell
- **THEN** the materialized text SHALL be identical to the text materialized before this change
- **AND** SHALL NOT contain the review verdict schema block

#### Scenario: No unsubstituted placeholder reaches the harness

- **WHEN** any stage prompt is materialized
- **THEN** the prompt SHALL contain no literal `{{schema_block}}` or other unsubstituted `{{…}}` token

---

### Requirement: Review-stage output SHALL be parsed by the production verdict parser

The runner SHALL extract a review cell's findings using the production review verdict
parsers (`core/scripts/stages/review-parsing.ts`) rather than an evaluation-local JSON
reader, so any verdict a production review round would have parsed is a verdict the
evaluation parses. This SHALL include output in which the verdict appears inside a fenced
JSON block or as an inline JSON object surrounded by other text.

Parsed findings SHALL retain every declared `ReviewFinding` field the treatment emitted,
including the `file`, `line_start`, `line_end`, and `severity` fields the review grader
matches against seeded defects. When a verdict is parsed, its findings SHALL be recorded
as `detail.findings` so the review grader consumes them; when no verdict can be parsed,
`detail.findings` SHALL be absent rather than an empty array.

#### Scenario: A fenced verdict block is parsed

- **WHEN** a review-stage treatment returns a fenced ```json verdict block surrounded by other prose
- **THEN** the runner SHALL parse it and record its findings as `detail.findings`

#### Scenario: A bare verdict object is still parsed

- **WHEN** a review-stage treatment returns the verdict JSON object as its entire output
- **THEN** the runner SHALL parse it and record its findings as `detail.findings`, exactly as before this change

#### Scenario: Parsed findings reach the review grader

- **WHEN** a review-stage treatment returns a valid verdict whose finding names the path and overlapping line range of a fixture's seeded defect
- **THEN** the review grader SHALL count that defect as a true positive rather than a false negative

#### Scenario: Findings retain the fields the grader matches on

- **WHEN** a review-stage treatment emits a finding carrying `file`, `line_start`, `line_end`, and `severity`
- **THEN** the finding recorded on `detail.findings` SHALL carry those values unchanged

---

### Requirement: A review cell record SHALL disclose whether the treatment satisfied the verdict contract

Every completed `review`-stage cell record SHALL carry a parse-provenance value on its
detail distinguishing at least: output that satisfied the full verdict contract, output
recovered by tolerant parsing, and output from which no verdict could be parsed. Prose or
other non-verdict output SHALL be classified as unparseable and SHALL NOT be recorded as a
verdict carrying zero findings, so a genuinely empty review is distinguishable from a
treatment that never answered in the contract.

Unparseable review output SHALL remain a completed treatment outcome, not an
infrastructure error — the treatment was asked correctly and answered non-compliantly, and
that non-compliance is itself a measured result. The value SHALL be an additive detail key,
consistent with the append-only results contract.

#### Scenario: Contract-satisfying output is disclosed as such

- **WHEN** a review-stage treatment returns a verdict satisfying the full verdict schema
- **THEN** the cell record SHALL disclose a parse provenance indicating the contract was satisfied

#### Scenario: Prose output is disclosed as unparseable

- **WHEN** a review-stage treatment returns prose containing no parseable verdict
- **THEN** the cell record SHALL disclose a parse provenance of unparseable
- **AND** `detail.findings` SHALL be absent
- **AND** the cell SHALL be recorded with result class `completed`, not as an infrastructure error

#### Scenario: A recovered partial verdict is distinguishable from a compliant one

- **WHEN** a review-stage treatment returns a JSON verdict whose findings omit a field the strict contract requires
- **THEN** the runner SHALL still record the recovered findings as `detail.findings`
- **AND** the cell record SHALL disclose a parse provenance distinct from the contract-satisfying one

#### Scenario: Both execution paths disclose provenance

- **WHEN** a `review`-stage cell is executed either through a local CLI harness or through a model-endpoint executor treatment
- **THEN** the cell record SHALL carry the parse-provenance value in both cases
