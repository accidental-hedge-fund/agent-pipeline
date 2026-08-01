## ADDED Requirements

### Requirement: Review non-convergence SHALL have a distinct blocker kind and recovery recipe
The closed `BlockerKind` set SHALL include `review-findings`. Exact review recurrence,
non-demotable surface recurrence, and non-demotable round-ceiling exhaustion SHALL use this kind
when actionable blocking findings remain. Its recipe SHALL state that the durable controller owns
bounded remediation and fresh review and that manual intervention is reserved for typed exhaustion
or an explicit authority decision. Diagnostic projection SHALL map `review-findings` to the
distinct durable `review-findings` class and recover disposition.

#### Scenario: Review recurrence uses review-findings
- **WHEN** all current blocking findings recur after an attested fix attempt
- **THEN** `setBlocked` SHALL receive blocker kind `review-findings`
- **AND** the diagnostic SHALL project to durable class `review-findings` and disposition `recover`

#### Scenario: Recipe remains actionable and non-human
- **WHEN** the blocked recipe for `review-findings` is rendered
- **THEN** it SHALL describe bounded controller remediation followed by a fresh review
- **AND** it SHALL NOT instruct the operator to answer, override, or clear a false human hold as the primary action

#### Scenario: Exhaustiveness tests cover review-findings
- **WHEN** blocker recipe and intervention mappings are inspected by the test suite
- **THEN** `review-findings` SHALL have a non-empty recipe and a deterministic mapping

### Requirement: Review recovery SHALL bypass stage-local retry and label-only redispatch
`review-findings` SHALL NOT be eligible for the stage-local `auto_loop`. Its durable policy entry
SHALL select `repair_pipeline_item` as the first action and SHALL NOT select `rerun_ci`,
`resync_workflow_state`, or another label-clearing action before substantive repair.

#### Scenario: Auto-loop leaves review recovery to the supervisor
- **WHEN** a review stage returns a blocked `review-findings` outcome
- **THEN** the in-process auto-loop SHALL NOT clear the block or repeat the same review stage
- **AND** the durable supervisor SHALL retain the diagnostic for recovery

#### Scenario: First durable action repairs the candidate
- **WHEN** the supervisor claims a `review-findings` recovery attempt with a current candidate head
- **THEN** its selected action SHALL be `repair_pipeline_item`
- **AND** no earlier action SHALL redispatch the unchanged candidate
