## MODIFIED Requirements

### Requirement: Auto-filed issues SHALL carry only the `pipeline:backlog` label and SHALL NOT be advanced

Every auto-filed issue SHALL be created with the `pipeline:backlog` label. Non-engine-class
auto-filed issues SHALL receive no other label. Engine-class auto-filed issues (clusters whose
signal or typed disposition projects to the FRG/engine-class taxonomy, including
`workflow-engine-defect`) SHALL additionally receive the `bug` label and the stable
`pipeline:engine-class` marker label so release open-soak-defect fallback queries and operators can
index them; those two labels are index markers only and SHALL NOT be treated as pipeline stage
labels. No auto-filed issue SHALL receive an assignee, milestone, or pipeline stage label; the
engine SHALL NOT enqueue it, SHALL NOT start a pipeline run for it, and SHALL NOT advance it toward
`pipeline:ready` or any later stage.

#### Scenario: Auto-filed issue is labelled backlog

- **WHEN** an issue is auto-filed from a papercut cluster
- **THEN** it SHALL carry the `pipeline:backlog` label

#### Scenario: Non-engine-class auto-filed issue carries nothing else

- **WHEN** an auto-filed issue is created from a non-engine-class papercut cluster
- **AND** it is inspected immediately after creation
- **THEN** it SHALL have no label other than `pipeline:backlog`, no assignee, and no milestone

#### Scenario: Engine-class auto-filed issue carries bug and engine-class marker

- **WHEN** an auto-filed issue is created from an engine-class papercut cluster
- **THEN** it SHALL carry `pipeline:backlog`, `bug`, and `pipeline:engine-class`
- **AND** it SHALL have no assignee, no milestone, and no pipeline stage label

#### Scenario: Auto-filed issue is not queued or advanced

- **WHEN** an issue has been auto-filed during a run or a queue batch
- **THEN** the engine SHALL NOT start a pipeline run for it, SHALL NOT add it to the current batch,
  and SHALL NOT apply any label that would advance it past `pipeline:backlog`
