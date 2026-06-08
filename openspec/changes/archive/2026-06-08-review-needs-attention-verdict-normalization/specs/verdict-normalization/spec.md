## ADDED Requirements

### Requirement: Zero-findings needs-attention triggers re-review, not fix

When a review round completes with verdict `needs-attention` and `findings.length === 0`, the pipeline SHALL NOT transition to a fix stage. Instead it SHALL invoke the same review round once more (re-review attempt 1). If the re-review produces a structured verdict with findings, normal routing resumes. If the re-review again produces `needs-attention` with zero findings (or produces an unstructured/fallback verdict), the pipeline SHALL transition to `blocked` and include the raw reviewer output in the block comment.

#### Scenario: First attempt yields needs-attention with 0 findings, re-review yields real findings

- **WHEN** a review round produces `verdict: "needs-attention"` and `findings: []`
- **AND** this is the first attempt (retryCount = 0)
- **AND** the re-review produces `verdict: "needs-attention"` with `findings.length > 0`
- **THEN** the pipeline SHALL route to the appropriate fix stage with the re-review's findings
- **AND** no fix stage SHALL have been invoked for the zero-findings attempt

#### Scenario: First attempt yields needs-attention with 0 findings, re-review also yields 0 findings

- **WHEN** a review round produces `verdict: "needs-attention"` and `findings: []`
- **AND** this is the first attempt (retryCount = 0)
- **AND** the re-review also produces `verdict: "needs-attention"` and `findings: []`
- **THEN** the pipeline SHALL transition to `blocked`
- **AND** the block comment SHALL include the raw reviewer output (`_raw`) from the re-review
- **AND** no fix stage SHALL be invoked

#### Scenario: First attempt yields needs-attention with 0 findings, re-review approves

- **WHEN** a review round produces `verdict: "needs-attention"` and `findings: []`
- **AND** this is the first attempt (retryCount = 0)
- **AND** the re-review produces `verdict: "approve"`
- **THEN** the pipeline SHALL route to approval (advance to the next stage)
- **AND** no fix stage SHALL be invoked

#### Scenario: Structured needs-attention with findings routes to fix normally

- **WHEN** a review round produces `verdict: "needs-attention"` and `findings.length > 0`
- **THEN** the pipeline SHALL transition to the appropriate fix stage as before
- **AND** no re-review attempt is made

### Requirement: Fallback parse path is logged

When `parseStructuredVerdict` cannot find a valid JSON verdict in the reviewer output and falls back to the text-based parse path, the pipeline SHALL emit a warning log line that identifies the fallback condition, and the returned verdict object SHALL include the `_raw` field populated with the first 4000 characters of the raw output.

#### Scenario: JSON verdict present — no fallback log

- **WHEN** the reviewer output contains a valid fenced or inline JSON block with `"verdict": "approve"` or `"verdict": "needs-attention"`
- **THEN** `parseStructuredVerdict` SHALL return the structured verdict without emitting a fallback warning
- **AND** the returned object SHALL NOT include `_raw`

#### Scenario: No parseable JSON — fallback log emitted

- **WHEN** the reviewer output contains no valid JSON block with a recognized verdict field
- **THEN** `parseStructuredVerdict` SHALL emit a `console.warn` message indicating a fallback occurred
- **AND** the returned verdict object SHALL include `_raw` populated with the raw output
- **AND** the verdict value SHALL be the result of `parseTextVerdict`

### Requirement: Regression coverage for normalization gate and parse paths

The test suite SHALL include unit tests that cover:
- `needs-attention` + `findings: []` from `advanceReview` does not invoke the fix harness on the first attempt.
- Native-review prose (no JSON) parses via `parseTextVerdict` and sets `_raw`.
- A valid fenced JSON verdict parses correctly and does not set `_raw`.
- After re-review, `needs-attention` + `findings: []` on second attempt results in a `blocked` outcome.

#### Scenario: Unit test — zero findings does not advance to fix

- **WHEN** `advanceReview` receives a mocked review result with `verdict: "needs-attention"` and `findings: []`
- **AND** retryCount is 0
- **THEN** the fix-stage transition SHALL NOT be called
- **AND** a re-review invocation SHALL be made instead

#### Scenario: Unit test — second zero-findings attempt blocks

- **WHEN** `advanceReview` receives a mocked review result with `verdict: "needs-attention"` and `findings: []`
- **AND** retryCount is 1
- **THEN** `setBlocked` SHALL be called with a message referencing the raw output
- **AND** no fix-stage transition SHALL be called

#### Scenario: Unit test — prose output sets _raw

- **WHEN** `parseStructuredVerdict` is called with a prose-only string (no JSON)
- **THEN** the result SHALL include `_raw` with the raw string
- **AND** `verdict` SHALL be `"needs-attention"` (conservative text default)

#### Scenario: Unit test — fenced JSON verdict does not set _raw

- **WHEN** `parseStructuredVerdict` is called with output containing a fenced JSON block with `"verdict": "approve"`
- **THEN** the result SHALL have `verdict: "approve"` and SHALL NOT include `_raw`
