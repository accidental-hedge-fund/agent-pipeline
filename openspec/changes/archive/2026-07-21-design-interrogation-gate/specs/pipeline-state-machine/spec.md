## MODIFIED Requirements

### Requirement: Canonical ordered stage sequence
The pipeline SHALL define its stages as an ordered constant `STAGES` in `core/scripts/types.ts`. Each stage is represented on an issue by the label `pipeline:<stage>` (prefix `LABEL_PREFIX = "pipeline:"`), and an issue carries at most one `pipeline:<stage>` label at a time.

`design-gate` (#436) SHALL sit between `implementing` and `review-1`. It is always traversed, but it is
inert unless the design-interrogation gate is enabled and a risk trigger matches: when disabled or
untriggered it SHALL advance immediately to `review-1` with a recorded reason and no harness call. Its
gate behavior is specified by the `design-interrogation-gate` capability.

#### Scenario: STAGES order
- **WHEN** the `STAGES` constant is inspected
- **THEN** it SHALL list, in order: `backlog`, `ready`, `planning`, `plan-review`, `implementing`, `design-gate`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`
- **AND** `design-gate` SHALL appear at an index greater than `implementing` and less than `review-1`
- **AND** `visual-gate` SHALL appear at an index greater than `pre-merge` and less than `eval-gate`
- **AND** `eval-gate` SHALL appear at an index greater than `visual-gate` and less than `shipcheck-gate`
- **AND** `shipcheck-gate` SHALL appear at an index greater than `eval-gate` and less than `ready-to-deploy`

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

## ADDED Requirements

### Requirement: design-gate SHALL be a model-invoking stage only when it fires

`design-gate` SHALL be included in `MODEL_INVOKING_STAGES` so it participates in per-stage model/effort
routing and external stage-executor assignment. It SHALL NOT be a member of `PROMPT_CONTAINED_STAGES`,
because both the implementer's decision-record emission and the reviewer's challenge round require
repository access. When the gate does not fire, the stage SHALL make no model call despite its
membership in `MODEL_INVOKING_STAGES`.

#### Scenario: design-gate participates in model routing
- **WHEN** `MODEL_INVOKING_STAGES` is inspected
- **THEN** it SHALL contain `design-gate`

#### Scenario: design-gate is not prompt-contained
- **WHEN** `PROMPT_CONTAINED_STAGES` is inspected
- **THEN** it SHALL NOT contain `design-gate`
- **AND** assigning a `model-endpoint` executor to `design-gate` SHALL be rejected at config-parse time

#### Scenario: untriggered gate makes no model call
- **WHEN** the `design-gate` stage runs and the gate does not fire
- **THEN** no model or harness invocation SHALL be recorded for that stage
