## ADDED Requirements

### Requirement: ReviewVerdict type includes a commitSha field

The `ReviewVerdict` type SHALL include a `commitSha` field containing the full 40-character HEAD SHA at the time the verdict was produced. This field is populated by `parseStructuredVerdict` from data supplied by the review stage; it is not parsed from the reviewer's output text.

#### Scenario: commitSha is present on every parsed verdict

- **WHEN** `parseStructuredVerdict` returns a verdict object
- **THEN** the returned object SHALL include `commitSha` as a non-empty string
- **AND** `commitSha` SHALL be exactly 40 hex characters

#### Scenario: commitSha does not affect verdict routing

- **WHEN** the verdict routing logic reads `verdict: "approve"` or `verdict: "needs-attention"`
- **THEN** the presence or absence of `commitSha` SHALL NOT change which branch is taken
- **AND** existing needs-attention + zero-findings retry logic SHALL be unaffected
