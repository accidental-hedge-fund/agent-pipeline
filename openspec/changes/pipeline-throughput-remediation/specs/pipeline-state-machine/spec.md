## ADDED Requirements

### Requirement: Ready dispatch records planning substages separately

When an issue starts at `pipeline:ready`, the pipeline SHALL transition the issue to `pipeline:planning` before any long-running planning work, worktree bootstrap, or harness invocation begins. The run artifacts SHALL record separate stage lifecycle entries for `planning`, `plan-review`, and `implementing` when those substages run inside the compound planning flow. The outer `ready` dispatch SHALL NOT record one wrapper lifecycle entry whose duration covers plan review and implementation.

#### Scenario: Planning label set before authoring
- **WHEN** an issue labelled `pipeline:ready` enters the planning flow
- **THEN** the pipeline SHALL transition it to `pipeline:planning` before invoking the planning harness
- **AND** a planning harness failure SHALL block the issue at `planning`, not `ready`

#### Scenario: Compound planning flow emits substage lifecycle
- **WHEN** one advance invocation performs planning, plan-review, and implementation work from a `ready` issue
- **THEN** `events.jsonl` SHALL contain separate `stage_start` and `stage_complete` pairs for `planning`, `plan-review`, and `implementing`
- **AND** the evidence bundle SHALL contain separate stage records for those substages
- **AND** it SHALL NOT contain a single `planning` stage record that wraps the whole compound flow

### Requirement: Fix rounds enforce stale OpenSpec deltas before push

When a fix round changes implementation files after the latest OpenSpec spec-delta update, and the latest structured review verdict includes `category: spec-divergence`, the pipeline SHALL block the fix round before pushing. The condition SHALL match the existing pre-merge stale-delta guard so false-positive behavior does not broaden.

#### Scenario: Stale delta blocks before fix push
- **WHEN** a fix round produces implementation changes after the latest `openspec/changes/<id>/specs/**` change
- **AND** the latest structured review verdict contains `category: spec-divergence`
- **THEN** the fix round SHALL set a blocker with kind `openspec-stale-delta`
- **AND** it SHALL NOT push the branch

#### Scenario: Updated delta clears fix-round guard
- **WHEN** a fix round updates `openspec/changes/<id>/specs/**` after the latest implementation change
- **THEN** the stale-delta guard SHALL pass
- **AND** the fix round MAY proceed to push if all other gates pass
