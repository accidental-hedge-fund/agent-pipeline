## ADDED Requirements

### Requirement: Review rounds SHALL refuse assembled prompts that exceed the reviewer input character ceiling before harness spawn

For both `review-1` and `review-2`, after the review prompt is fully assembled for the attempt (the output of `buildReviewStandardPrompt` or `buildReviewAdversarialPrompt` plus any same-path sections that are part of the text delivered to the reviewer) and **before** any reviewer harness, ensemble member, or stage-executor spawn that would deliver that prompt, the pipeline SHALL count the assembled prompt’s character length.

The effective ceiling SHALL be:

1. the configured reviewer’s declared finite maximum prompt size when such a finite declaration exists; otherwise
2. `1048576` characters (the Codex input character ceiling used when no finite declaration is available).

When the assembled character count is **strictly greater** than the effective ceiling, the pipeline SHALL:

- call `setBlocked` with blocker kind `review-prompt-too-large`;
- return a blocked outcome whose `blockerKind` is `review-prompt-too-large`;
- include the measured size and the ceiling in the blocked reason when those values are known;
- **NOT** spawn the reviewer harness (or ensemble / stage-executor delivery of that prompt) for that attempt;
- **NOT** skip review and advance the stage.

When the assembled character count is less than or equal to the effective ceiling, this preflight SHALL NOT block solely for size, and the existing review invoke path SHALL run unchanged.

This preflight is additive to existing adapter byte-limit preflight (`maxPromptBytes` / production treatment preflight). It does not authorize reducing, chunking, or rewriting prompt content, and it does not authorize advancing without a successful review.

#### Scenario: Oversize review-1 prompt never spawns the reviewer

- **WHEN** `review-1` assembles a prompt whose character length is greater than the effective ceiling
- **THEN** the pipeline SHALL block with `blockerKind: "review-prompt-too-large"`
- **AND** SHALL NOT invoke the reviewer harness for that attempt
- **AND** SHALL NOT advance the issue past `review-1`

#### Scenario: Oversize review-2 prompt never spawns the reviewer

- **WHEN** `review-2` assembles a prompt whose character length is greater than the effective ceiling
- **THEN** the pipeline SHALL block with `blockerKind: "review-prompt-too-large"`
- **AND** SHALL NOT invoke the reviewer harness for that attempt
- **AND** SHALL NOT advance the issue past `review-2`

#### Scenario: Under-ceiling prompt still invokes the reviewer

- **WHEN** a review round assembles a prompt whose character length is less than or equal to the effective ceiling
- **THEN** this preflight SHALL NOT block the round for size
- **AND** the reviewer harness invoke path SHALL proceed as before this requirement

#### Scenario: Ceiling falls back to Codex 1048576 when no finite declaration exists

- **WHEN** the configured reviewer has no finite declared maximum (missing, unlimited, or unknown)
- **AND** the assembled review prompt length is `1048577` characters or greater
- **THEN** the pipeline SHALL treat the ceiling as `1048576` and block with `review-prompt-too-large` without spawning the reviewer

#### Scenario: Finite declared reviewer max is used when present

- **WHEN** the configured reviewer declares a finite maximum prompt size M
- **AND** the assembled review prompt character length is greater than M
- **THEN** the pipeline SHALL block with `review-prompt-too-large` without spawning the reviewer
- **AND** SHALL use M (not necessarily `1048576`) as the ceiling in the blocked reason when the reason includes the ceiling
