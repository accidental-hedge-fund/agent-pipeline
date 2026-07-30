## RENAMED Requirements

- FROM: `### Requirement: Terminal stage is ready-to-deploy`
- TO: `### Requirement: Terminal stages are ready-to-deploy and needs-human`

## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

`needs-human` SHALL appear in `STAGES` after `ready-to-deploy` as the terminal off-ramp stage. It is
not the happy-path success terminal; issues reach it via documented park paths (e.g. adversarial-round
ceiling with findings still blocking), not by advancing past `ready-to-deploy`.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`, `needs-human`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`
- **AND** `needs-human` SHALL appear at an index greater than `ready-to-deploy`

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
`TERMINAL_STAGES` SHALL contain exactly `ready-to-deploy` and `needs-human`. When an issue reaches either terminal stage, the advance loop stops and no further stage handler is dispatched for autonomous progression.

- `ready-to-deploy` is the successful autonomous-loop terminal: the run finalizes (tagging the PR and posting a summary). No stage follows it on the happy path; a human owns the merge button.
- `needs-human` is the terminal off-ramp: the item parks with an advisory punch-list for a human to override or fix. The advance loop SHALL NOT auto-advance from `needs-human` to `ready-to-deploy`. Resume paths (e.g. `--override`) are specified separately and do not remove `needs-human` from `TERMINAL_STAGES`.

#### Scenario: reaching the successful terminal stage
- **WHEN** an issue advances to `ready-to-deploy`
- **THEN** the run SHALL finalize (tagging the PR `pipeline:ready-to-deploy` and posting a summary) and stop
- **AND** no further stage handler SHALL be dispatched

#### Scenario: reaching the needs-human terminal off-ramp
- **WHEN** an issue is parked at `needs-human`
- **THEN** the advance loop SHALL stop without promoting the issue to `ready-to-deploy`
- **AND** no further stage handler SHALL be dispatched for autonomous progression

#### Scenario: TERMINAL_STAGES membership
- **WHEN** the `TERMINAL_STAGES` constant is inspected
- **THEN** it SHALL contain exactly `ready-to-deploy` and `needs-human`
- **AND** it SHALL NOT omit `needs-human`
