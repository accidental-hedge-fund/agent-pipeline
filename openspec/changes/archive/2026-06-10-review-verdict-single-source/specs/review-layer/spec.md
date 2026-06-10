## MODIFIED Requirements

### Requirement: reviewMode selects the review backend
The review backend SHALL be selected by `cfg.review_mode`. `prompt-harness` (the default) SHALL invoke the reviewer-role harness CLI directly with the pipeline's own review prompt and require no companion plugin. The companion modes (`claude-companion`, `codex-companion`) are optional and drive the reviewer through a third-party plugin (`isCompanionMode` distinguishes them). The review prompt SHALL be assembled by a prompt-building function that substitutes `{{schema_block}}` with the shared `REVIEW_VERDICT_SCHEMA_BLOCK` constant before sending the prompt to the reviewer.

#### Scenario: prompt-harness review
- **WHEN** a review round runs with `review_mode: "prompt-harness"`
- **THEN** the reviewer harness CLI SHALL be invoked directly with the JSON-returning review prompt and no companion plugin SHALL be required

#### Scenario: schema block is substituted in the prompt
- **WHEN** the review prompt is assembled for either review round
- **THEN** the `{{schema_block}}` placeholder SHALL be replaced with the current `REVIEW_VERDICT_SCHEMA_BLOCK` text before the prompt is sent
