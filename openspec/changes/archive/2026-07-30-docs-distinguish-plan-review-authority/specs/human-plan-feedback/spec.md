## ADDED Requirements

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
