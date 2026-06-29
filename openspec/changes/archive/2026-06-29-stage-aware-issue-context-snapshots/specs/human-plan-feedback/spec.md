## ADDED Requirements

### Requirement: Human comments posted after the revised plan require re-plan or explicit override before folding into subsequent stages
When the pipeline detects human comments posted after the `## Revised Implementation Plan` comment, those comments SHALL NOT be silently folded into implementation, review, or fix-round prompts. The pipeline SHALL surface them as unacknowledged new input (per the `issue-context-snapshot` spec's new-comment detection requirement) and require the maintainer to either trigger a re-plan or post an explicit scope-override comment before the comments are acted upon. Only after a re-plan (new `## Implementation Plan` → `## Revised Implementation Plan` cycle) or an explicit override comment has been posted SHALL the pipeline incorporate the new human comments as context.

#### Scenario: New human comment posted after revised plan — no override
- **WHEN** a human comment is posted after the `## Revised Implementation Plan` comment
- **AND** the maintainer has NOT posted a re-plan trigger or explicit scope-override comment
- **THEN** the pipeline SHALL NOT include the new comment's text in the review-1, review-2, or any fix-round prompt
- **AND** the pipeline SHALL post a `## Pipeline: New human input detected` warning (as specified in `issue-context-snapshot`) before the next stage boundary

#### Scenario: New human comment acknowledged via re-plan
- **WHEN** a human comment is posted after the `## Revised Implementation Plan` comment
- **AND** the pipeline runs a new planning cycle (a new `## Implementation Plan` comment is posted)
- **THEN** the new human comment SHALL be included in the next revision step's human-feedback list (per the existing `human-plan-feedback` requirement for comments after the plan)
- **AND** the unacknowledged-input warning SHALL be cleared

#### Scenario: New human comment acknowledged via explicit override
- **WHEN** a human comment is posted after the `## Revised Implementation Plan` comment
- **AND** a maintainer posts an explicit scope-override comment (a comment beginning with a recognized override prefix)
- **THEN** the pipeline SHALL treat the override as acknowledgement
- **AND** the unacknowledged-input warning SHALL NOT be re-posted for the same comments in subsequent stages
