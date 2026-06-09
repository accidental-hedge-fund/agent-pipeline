# configurable-steps Specification

## Purpose
Which pipeline steps a repo may toggle off (the thoroughness steps: plan-review, standard review, adversarial review, docs) versus the always-on structural spine, and how disabling a step reroutes the state graph while always preserving a valid forward path to `ready-to-deploy`.

## Requirements

### Requirement: Four toggleable steps default on
`PipelineConfig.steps` SHALL expose exactly four boolean toggles — `plan_review`, `standard_review`, `adversarial_review`, `docs` — each defaulting to `true` in `DEFAULT_CONFIG.steps`. A repo overrides them via the `steps:` block in `.github/pipeline.yml`. The structural spine (planning, implementing, pre-merge and its CI/mergeability gates, eval-gate) has no toggle and always runs.

#### Scenario: defaults when steps omitted
- **WHEN** `.github/pipeline.yml` has no `steps:` block
- **THEN** `cfg.steps` SHALL be `{ plan_review: true, standard_review: true, adversarial_review: true, docs: true }`

#### Scenario: selective disable
- **WHEN** the `steps:` block sets `adversarial_review: false` and `docs: false`
- **THEN** those two SHALL be `false` and the unspecified toggles SHALL remain `true`

### Requirement: Disabling plan-review skips the plan-review round
When `cfg.steps.plan_review` is `false`, the planning stage SHALL transition `planning` → `implementing` directly, omitting the secondary-harness plan review and the plan-revision step, and implement the original plan.

#### Scenario: plan-review disabled
- **WHEN** `cfg.steps.plan_review` is `false`
- **THEN** planning SHALL not transition to `plan-review`
- **AND** SHALL transition directly from `planning` to `implementing`

### Requirement: Disabling a review round reroutes via reviewStageSkipTarget
When a review step is disabled, the orchestrator SHALL skip the review handler and transition forward to the target returned by `reviewStageSkipTarget(cfg, stage)`: from `review-1`, to `review-2` when `adversarial_review` is enabled else `pre-merge`; from `review-2`, always `pre-merge`.

#### Scenario: standard review disabled, adversarial enabled
- **WHEN** `cfg.steps.standard_review` is `false` and `adversarial_review` is `true` and the stage is `review-1`
- **THEN** `reviewStageSkipTarget` SHALL return `review-2`
- **AND** the orchestrator SHALL transition `review-1` → `review-2` without invoking a review handler

#### Scenario: both review rounds disabled
- **WHEN** both `standard_review` and `adversarial_review` are `false` and the stage is `review-1`
- **THEN** `reviewStageSkipTarget` SHALL return `pre-merge`

### Requirement: Disabling docs skips the docs-update sub-step
When `cfg.steps.docs` is `false`, the pre-merge stage SHALL NOT invoke the docs-update harness or push documentation commits, and SHALL proceed to the CI/mergeability gates.

#### Scenario: docs disabled
- **WHEN** `cfg.steps.docs` is `false`
- **THEN** pre-merge SHALL skip the docs-update harness and push no docs commit

### Requirement: Skip routing always preserves a forward path
For every combination of disabled steps, the routing SHALL leave a valid forward path from the current stage to `pre-merge` (and onward to `ready-to-deploy`); no disable combination creates a cycle or a dead end. The structural spine (planning → implementing → pre-merge → ready-to-deploy) is always intact.

#### Scenario: all thoroughness steps disabled still reaches terminal
- **WHEN** `plan_review`, `standard_review`, `adversarial_review`, and `docs` are all `false`
- **THEN** an issue SHALL still traverse planning → implementing → (review rounds skipped) → pre-merge → ready-to-deploy
