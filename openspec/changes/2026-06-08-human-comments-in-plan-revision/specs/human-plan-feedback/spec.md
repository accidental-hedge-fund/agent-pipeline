## ADDED Requirements

### Requirement: Human comments posted after the plan are captured before revision

When the pipeline is about to build the plan-revision prompt and `steps.plan_review` is enabled, it SHALL fetch the current issue comments and identify any human comments posted after the `## Implementation Plan` comment.

A comment is considered **human** if:
1. Its `createdAt` timestamp is later than the `## Implementation Plan` comment's `createdAt`, AND
2. Its body does NOT begin with one of the known pipeline comment headers: `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review 1`, `## Review 2`, `## Fix 1`, `## Fix 2`.

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
