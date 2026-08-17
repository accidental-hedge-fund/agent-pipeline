# human-plan-feedback Specification

## Purpose
TBD - created by archiving change 2026-06-08-human-comments-in-plan-revision. Update Purpose after archive.

## Requirements

### Requirement: Human comments posted after the plan are captured before revision

When the pipeline is about to build the plan-revision prompt and `steps.plan_review` is enabled, it SHALL fetch the current issue comments and identify any human comments posted after the `## Implementation Plan` comment.

A comment is considered **human** if:
1. It is posted after the `## Implementation Plan` comment (comments are returned in chronological order, so position after the plan-comment anchor establishes this), AND
2. Its body does NOT begin with one of the known pipeline comment headers: `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review 1`, `## Review 2`, `## Fix 1`, `## Fix 2`, `## Pipeline:`, `## Pre-Planning Context`.

The `## Pipeline:` prefix (stage-transition and blocked comments) is essential: the pipeline posts `## Pipeline: plan review` between the plan comment and the reviewer feedback, so omitting it would misclassify that transition comment as human input on every run.

#### Scenario: No comments follow the plan comment

- **WHEN** the pipeline fetches issue comments before the revision step
- **AND** no comments were posted after the `## Implementation Plan` comment
- **THEN** the human comment list SHALL be empty
- **AND** the revision prompt SHALL be built exactly as today (no human feedback section rendered)

#### Scenario: Only pipeline-generated comments follow the plan comment

- **WHEN** all comments after the plan comment begin with a known pipeline header
- **THEN** the human comment list SHALL be empty
- **AND** the revision prompt SHALL be built exactly as today

#### Scenario: Human comments are present after the plan comment

- **WHEN** one or more comments following the `## Implementation Plan` comment do NOT begin with a known pipeline header
- **THEN** those comments SHALL be included in the human comment list
- **AND** each entry SHALL carry the commenter's GitHub login and the comment body

---

### Requirement: Human feedback is included in the revision prompt as a distinct block

When one or more human comments are identified, the revision prompt passed to the implementer harness SHALL include them as a clearly labeled block separate from the reviewer harness feedback.

#### Scenario: Revision prompt includes human feedback

- **WHEN** the human comment list is non-empty
- **THEN** the revision prompt SHALL contain a section labeled with human authorship (e.g., `Human comments on the plan:`)
- **AND** each human comment SHALL be rendered as `@<login>: <body>` separated by blank lines
- **AND** the prompt SHALL instruct the implementer to address both the reviewer harness feedback and the human feedback

#### Scenario: Revision prompt omits human feedback section when list is empty

- **WHEN** the human comment list is empty
- **THEN** the revision prompt SHALL NOT include the human feedback section
- **AND** the rendered prompt SHALL be byte-for-byte equivalent to a prompt generated with no human feedback parameter

---

### Requirement: Revised-plan comment attributes human commenters

When human comments were incorporated into the revision, the `## Revised Implementation Plan` comment posted to the issue SHALL list the GitHub logins of the contributing humans.

#### Scenario: Revised-plan comment includes human attribution

- **WHEN** the human comment list is non-empty
- **THEN** the revised-plan comment header SHALL include a line of the form `**Human feedback from**: @login1, @login2`
- **AND** this line SHALL appear alongside the existing `**Based on review by**` attribution

#### Scenario: Revised-plan comment is unchanged with no human feedback

- **WHEN** the human comment list is empty
- **THEN** the revised-plan comment SHALL contain no `**Human feedback from**` line
- **AND** the comment format SHALL be identical to what the pipeline posts today

---

### Requirement: Feature is a no-op when `steps.plan_review` is disabled

When `steps.plan_review` is disabled the pipeline SHALL NOT fetch or inspect issue comments for human feedback, and implementation SHALL proceed from the original plan unchanged.

#### Scenario: `steps.plan_review` disabled — behavior unchanged

- **WHEN** `cfg.steps.plan_review` is `false`
- **THEN** the pipeline SHALL NOT fetch or inspect issue comments for human feedback
- **AND** implementation proceeds from the original plan as today

### Requirement: Human comments posted after the revised plan require re-plan or explicit override before folding into subsequent stages
When the pipeline detects **unacknowledged human input** (the `operator-scope-change` disposition from the `issue-context-snapshot` human-ack classifier) posted after the `## Revised Implementation Plan` comment, those comments SHALL NOT be silently folded into implementation, review, or fix-round prompts. The pipeline SHALL surface them as unacknowledged new input (per the `issue-context-snapshot` spec's new-comment detection requirement) and require the maintainer to either trigger a re-plan or post an explicit scope-override comment before the comments are acted upon. Only after a re-plan (new `## Implementation Plan` → `## Revised Implementation Plan` cycle) or an explicit override comment has been posted SHALL the pipeline incorporate those comments as context.

Comments disposed as `pipeline-or-operational` (verified pipeline output, trusted heading plus terminal artifact, or a closed operational note) SHALL NOT require a human re-plan or scope-override and SHALL NOT post the new-human-input warning. Comments disposed as `ambiguous-trusted` SHALL follow the `issue-context-snapshot` recover path (in-engine re-plan, not `needs-human` STOP) and SHALL NOT be folded into implement, review, or fix prompts until a new plan anchor exists.

#### Scenario: New human comment posted after revised plan — no override
- **WHEN** an `operator-scope-change` comment is posted after the `## Revised Implementation Plan` comment
- **AND** the maintainer has NOT posted a re-plan trigger or explicit scope-override comment
- **THEN** the pipeline SHALL NOT include the new comment's text in the review-1, review-2, or any fix-round prompt
- **AND** the pipeline SHALL post a `## Pipeline: New human input detected` warning (as specified in `issue-context-snapshot`) before the next stage boundary

#### Scenario: New human comment acknowledged via re-plan
- **WHEN** an `operator-scope-change` comment is posted after the `## Revised Implementation Plan` comment
- **AND** the pipeline runs a new planning cycle (a new `## Implementation Plan` comment is posted)
- **THEN** the new human comment SHALL be included in the next revision step's human-feedback list (per the existing `human-plan-feedback` requirement for comments after the plan)
- **AND** the unacknowledged-input warning SHALL be cleared

#### Scenario: New human comment acknowledged via explicit override
- **WHEN** an `operator-scope-change` comment is posted after the `## Revised Implementation Plan` comment
- **AND** a maintainer posts an explicit scope-override comment (a comment beginning with a recognized override prefix)
- **THEN** the pipeline SHALL treat the override as acknowledgement
- **AND** the unacknowledged-input warning SHALL NOT be re-posted for the same comments in subsequent stages

#### Scenario: Operational note after revised plan does not require human override
- **WHEN** the only post-plan comment is a trusted-actor closed operational note (grill / ship-halt / “don’t comment”) with no product-scope-change clause
- **THEN** the pipeline SHALL NOT post `## Pipeline: New human input detected`
- **AND** the pipeline SHALL NOT require a maintainer re-plan or scope-override before the next stage

### Requirement: Human plan comments are optional feedback, not human approval

Human comments captured after the `## Implementation Plan` comment when `steps.plan_review` is enabled SHALL be treated as optional human feedback inside the human feedback window, not as human approval or human sign-off. Presence of such comments SHALL NOT be required for plan-review to complete. Absence of such comments SHALL NOT block plan revision and SHALL NOT be recorded or described as human approval or human sign-off. Agent plan review remains the plan-review control (independent agent plan review when the configured reviewer ran; labeled same-harness self-review when that fallback applied); human comments only augment the revision prompt when present (per the existing human-feedback capture and acknowledgement requirements).

#### Scenario: No human comments — revision proceeds without approval semantics

- **WHEN** `steps.plan_review` is enabled
- **AND** the human comment list after the plan comment is empty
- **THEN** plan revision SHALL proceed without a human-feedback section
- **AND** the pipeline SHALL NOT block solely because no human commented
- **AND** the run SHALL NOT treat the empty list as human approval or sign-off

#### Scenario: Human comments present — feedback not approval

- **WHEN** one or more human comments are included in the revision prompt
- **THEN** those comments SHALL be labeled and handled as human feedback
- **AND** acknowledgement of those comments (when required) SHALL mean the reviser addressed or declined each feedback item
- **AND** that acknowledgement SHALL NOT be documented or treated as a substitute for a separate human-approval control (for example human merge at `ready-to-deploy`)

#### Scenario: Operator docs for this feature match the authority boundary

- **WHEN** product documentation describes human comments during plan-review
- **THEN** it SHALL describe them as optional feedback folded into revision
- **AND** it SHALL NOT describe the feature as a human sign-off gate on the plan
