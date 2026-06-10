# review-layer Specification

## Purpose
The foundational review behavior: a two-round review (standard `review-1`, adversarial `review-2`) driven by a pluggable backend selected by `reviewMode` (default `prompt-harness` — the reviewer CLI invoked directly with the pipeline's JSON-returning prompt; companion modes optional), with structured-verdict parsing that fails conservatively so findings are never silently dropped, and verdict-driven routing. (SHA-binding of verdicts is refined by `review-sha-gating`; the zero-findings re-review/normalization by `verdict-normalization`; post-harness commit invariants by `harness-step-verification`.)
## Requirements
### Requirement: reviewMode selects the review backend
The review backend SHALL be selected by `cfg.review_mode`. `prompt-harness` (the default) SHALL invoke the reviewer-role harness CLI directly with the pipeline's own review prompt and require no companion plugin. The companion modes (`claude-companion`, `codex-companion`) are optional and drive the reviewer through a third-party plugin (`isCompanionMode` distinguishes them). The review prompt SHALL be assembled by a prompt-building function that substitutes `{{schema_block}}` with the shared `REVIEW_VERDICT_SCHEMA_BLOCK` constant before sending the prompt to the reviewer.

#### Scenario: prompt-harness review
- **WHEN** a review round runs with `review_mode: "prompt-harness"`
- **THEN** the reviewer harness CLI SHALL be invoked directly with the JSON-returning review prompt and no companion plugin SHALL be required

#### Scenario: schema block is substituted in the prompt
- **WHEN** the review prompt is assembled for either review round
- **THEN** the `{{schema_block}}` placeholder SHALL be replaced with the current `REVIEW_VERDICT_SCHEMA_BLOCK` text before the prompt is sent

### Requirement: Two review rounds with verdict-driven routing
Review SHALL run as two rounds — `review-1` (standard) then `review-2` (adversarial). An `approve` verdict advances (`review-1`→`review-2`, `review-2`→`pre-merge`); a `needs-attention` verdict with findings routes to the matching fix stage (`review-1`→`fix-1`, `review-2`→`fix-2`).

#### Scenario: round 1 approves
- **WHEN** `review-1` returns `approve`
- **THEN** the issue SHALL advance to `review-2`

#### Scenario: round 2 needs attention
- **WHEN** `review-2` returns `needs-attention` with findings
- **THEN** the issue SHALL route to `fix-2`

### Requirement: Structured verdict parsing with a conservative fallback
`parseStructuredVerdict` SHALL extract a verdict from the reviewer output by trying, in order: a fenced ```json block, an inline `{…"verdict"…}` object, then a recognized Codex prose review. When none parse, it SHALL fall back conservatively — defaulting the verdict to `needs-attention`, emitting a warning, and attaching the raw output (`_raw`) — so a structured verdict is never silently treated as an approval.

#### Scenario: fenced JSON verdict
- **WHEN** the output contains a fenced ```json block with a valid `verdict`
- **THEN** the structured verdict SHALL be returned without the `_raw` fallback marker

#### Scenario: unparseable output
- **WHEN** the output contains no JSON and no recognized prose review
- **THEN** the verdict SHALL default to `needs-attention`, a warning SHALL be logged, and the raw output SHALL be attached as `_raw`

### Requirement: The review comment is posted before routing
The formatted review comment (verdict, summary, findings) SHALL be posted to the issue before any advance or block transition occurs.

#### Scenario: comment precedes the transition
- **WHEN** a review round completes with a parsed verdict
- **THEN** the review comment SHALL be posted before the stage transitions or blocks

