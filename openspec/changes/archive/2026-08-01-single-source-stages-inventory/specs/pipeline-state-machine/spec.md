## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

`needs-human` SHALL appear in `STAGES` as the terminal off-ramp entry (after `ready-to-deploy` in the
constant order). It is not a happy-path successor of `ready-to-deploy`; it is a park state the
advance loop may enter from review-ceiling and similar exhaustion paths. Its resume and status
surfaces are specified by the `needs-human-status-surface` and override-related capabilities.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`, `needs-human`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`
- **AND** `needs-human` SHALL appear after `ready-to-deploy` in the constant order
- **AND** `needs-human` SHALL be a member of `TERMINAL_STAGES`

#### Scenario: dispatch routes design-gate
- **WHEN** the current stage label is `pipeline:design-gate`
- **THEN** the orchestrator SHALL call the design-gate stage handler
- **AND** SHALL NOT call any review or `deployReady.finalize()` handler directly

#### Scenario: design-gate is a no-op when the gate is disabled
- **WHEN** the current stage is `design-gate` and `cfg.design_gate.enabled` is `false`
- **THEN** the issue SHALL transition to `review-1` in the same run
- **AND** no harness SHALL be invoked by the stage

#### Scenario: dispatch routes visual-gate
- **WHEN** the current stage label is `pipeline:visual-gate`
- **THEN** the orchestrator SHALL call the visual stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes eval-gate
- **WHEN** the current stage label is `pipeline:eval-gate`
- **THEN** the orchestrator SHALL call the eval stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

### Requirement: Terminal stages are ready-to-deploy and needs-human
`TERMINAL_STAGES` SHALL be exactly the set `{ready-to-deploy, needs-human}`. Both members stop the advance loop; neither is followed by another stage handler dispatch, and neither merges the PR.

When an issue reaches `ready-to-deploy`, the run finalizes the happy path (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and the advance loop stops. When an issue reaches `needs-human`, the advance loop stops at the park off-ramp with advisory evidence for a human (override or fix); the item is never auto-advanced from `needs-human` to `ready-to-deploy`.

#### Scenario: reaching the ready-to-deploy terminal stage
- **WHEN** an issue advances to `ready-to-deploy`
- **THEN** the run SHALL finalize (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and stop
- **AND** no further stage handler SHALL be dispatched
- **AND** the PR SHALL NOT be merged by the advance loop

#### Scenario: reaching the needs-human terminal stage
- **WHEN** an issue reaches `needs-human` (e.g. a review round hits its ceiling with findings still blocking)
- **THEN** the advance loop SHALL stop
- **AND** no further stage handler SHALL be dispatched to auto-advance toward `ready-to-deploy`
- **AND** the PR SHALL NOT be merged by the advance loop

#### Scenario: TERMINAL_STAGES membership
- **WHEN** the `TERMINAL_STAGES` constant is inspected
- **THEN** it SHALL contain exactly `ready-to-deploy` and `needs-human`
- **AND** it SHALL NOT omit `needs-human`
- **AND** it SHALL NOT contain any other stage name
